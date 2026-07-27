import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  ExecutionBackend,
  WorkerHandle,
} from "../node/execution-backend.js";
import type { WorkerResult, WorkerSpec } from "../node/worker-protocol.js";

export interface ExecutionBackendScenario<
  Result extends WorkerResult = WorkerResult,
> {
  readonly spec: WorkerSpec;
  readonly expected: Result;
}

/**
 * Worker behaviors used by the execution contract. The successful and failed
 * workers must exit after producing their expected result. The stalled worker
 * must remain running without producing a result until terminated.
 */
export interface ExecutionBackendContractScenarios {
  readonly successful: ExecutionBackendScenario<
    Extract<WorkerResult, { readonly status: "succeeded" }>
  >;
  readonly failed: ExecutionBackendScenario<
    Extract<WorkerResult, { readonly status: "failed" }>
  >;
  readonly stalled: WorkerSpec;
}

/**
 * Default scenarios understood by Prism's test worker. A custom worker image
 * can use these config modes or provide its own scenarios to the suite.
 */
export const DEFAULT_EXECUTION_BACKEND_SCENARIOS: ExecutionBackendContractScenarios =
  Object.freeze({
    successful: Object.freeze({
      spec: Object.freeze({
        runId: "success-run",
        nodeId: "success-node",
        kind: "task",
        executor: "contract",
        input: Object.freeze({ greeting: "hello" }),
        config: Object.freeze({ mode: "echo" }),
        attempt: 1,
      }),
      expected: Object.freeze({
        status: "succeeded",
        output: Object.freeze({ greeting: "hello" }),
      }),
    }),
    failed: Object.freeze({
      spec: Object.freeze({
        runId: "failure-run",
        nodeId: "failure-node",
        kind: "task",
        executor: "contract",
        input: null,
        config: Object.freeze({
          mode: "fail",
          error: "contract failure",
          failureClass: "semantic_failed",
        }),
        attempt: 1,
      }),
      expected: Object.freeze({
        status: "failed",
        error: "contract failure",
        failureClass: "semantic_failed",
      }),
    }),
    stalled: Object.freeze({
      runId: "stalled-run",
      nodeId: "stalled-node",
      kind: "task",
      executor: "contract",
      input: null,
      config: Object.freeze({ mode: "stall" }),
      attempt: 1,
    }),
  });

/** Creates a fresh execution backend for one contract test. */
export type ExecutionBackendFactory = () =>
  ExecutionBackend | Promise<ExecutionBackend>;

export interface ExecutionBackendContractOptions {
  /** Worker behaviors understood by the adapter's test worker. */
  readonly scenarios?: ExecutionBackendContractScenarios;
  /** Maximum wait for a worker to exit. Default 10 seconds. */
  readonly timeoutMs?: number;
}

/**
 * Registers Prism's backend-neutral ExecutionBackend conformance suite with
 * Vitest. Call this at module scope in a test file.
 *
 * `makeBackend` is called before each test. Every launched worker is
 * terminated afterward, followed by the backend's optional `close` method.
 */
export function runExecutionBackendContract(
  label: string,
  makeBackend: ExecutionBackendFactory,
  options: ExecutionBackendContractOptions = {},
): void {
  const scenarios = options.scenarios ?? DEFAULT_EXECUTION_BACKEND_SCENARIOS;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      "ExecutionBackend contract timeoutMs must be positive",
    );
  }

  describe(
    `ExecutionBackend contract: ${label}`,
    { timeout: timeoutMs * 2 },
    () => {
      let backend: ExecutionBackend | undefined;
      const handles = new Set<WorkerHandle>();

      beforeEach(async () => {
        backend = await makeBackend();
      });

      function open(): ExecutionBackend {
        if (backend === undefined) {
          throw new Error("ExecutionBackend factory did not complete");
        }
        return backend;
      }

      async function launch(spec: WorkerSpec): Promise<WorkerHandle> {
        const handle = await open().launch(spec);
        handles.add(handle);
        return handle;
      }

      afterEach(async () => {
        const opened = backend;
        backend = undefined;
        const pendingHandles = [...handles];
        handles.clear();
        if (opened !== undefined) {
          await Promise.allSettled(
            pendingHandles.map((handle) => opened.terminate(handle)),
          );
          await opened.close?.();
        }
      });

      test("launches, identifies, and collects a successful worker", async () => {
        const { spec, expected } = scenarios.successful;
        const handle = await launch(spec);

        expect(handle.id.length).toBeGreaterThan(0);
        expect(handle.runId).toBe(spec.runId);
        expect(handle.nodeId).toBe(spec.nodeId);
        await waitForExit(open(), handle, timeoutMs);
        await expect(open().collect(handle)).resolves.toEqual(expected);
        await expect(open().poll(handle)).resolves.toBe("exited");
      });

      test("collects a worker-reported classified failure", async () => {
        const { spec, expected } = scenarios.failed;
        const handle = await launch(spec);

        await waitForExit(open(), handle, timeoutMs);
        await expect(open().collect(handle)).resolves.toEqual(expected);
      });

      test("reports running, alive, idle, then dead across a stalled lifecycle", async () => {
        const handle = await launch(scenarios.stalled);
        await expect(open().poll(handle)).resolves.toBe("running");
        await expect(
          open().checkLiveness(handle, {
            idleTimeoutMs: Number.MAX_SAFE_INTEGER,
            now: 0,
          }),
        ).resolves.toBe("alive");
        await expect(
          open().checkLiveness(handle, {
            idleTimeoutMs: 0,
            now: Number.MAX_SAFE_INTEGER,
          }),
        ).resolves.toBe("idle");

        await open().terminate(handle);
        await expect(open().poll(handle)).resolves.toBe("exited");
        await expect(
          open().checkLiveness(handle, {
            idleTimeoutMs: 0,
            now: Number.MAX_SAFE_INTEGER,
          }),
        ).resolves.toBe("dead");
      });

      test("terminate is idempotent and a result-less worker cannot be collected", async () => {
        const handle = await launch(scenarios.stalled);
        await open().terminate(handle);
        await expect(open().terminate(handle)).resolves.toBeUndefined();
        await expect(open().collect(handle)).rejects.toThrow();
      });

      test("multiple workers have independent opaque identities", async () => {
        const first = await launch({
          ...scenarios.stalled,
          runId: "run/a",
          nodeId: "../worker:one",
          attempt: 1,
        });
        const second = await launch({
          ...scenarios.stalled,
          runId: "run?a",
          nodeId: "..?worker?one",
          attempt: 2,
        });

        expect(first.id).not.toBe(second.id);
        await open().terminate(first);
        await expect(open().poll(first)).resolves.toBe("exited");
        await expect(open().poll(second)).resolves.toBe("running");
      });

      test("rejects forged or unknown handles", async () => {
        const unknown: WorkerHandle = {
          id: "unknown-worker",
          runId: "unknown-run",
          nodeId: "unknown-node",
        };
        const liveness = { idleTimeoutMs: 1_000, now: 0 };

        await expect(open().poll(unknown)).rejects.toThrow();
        await expect(open().checkLiveness(unknown, liveness)).rejects.toThrow();
        await expect(open().terminate(unknown)).rejects.toThrow();
        await expect(open().collect(unknown)).rejects.toThrow();
      });
    },
  );
}

async function waitForExit(
  backend: ExecutionBackend,
  handle: WorkerHandle,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await backend.poll(handle)) === "exited") {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`contract worker did not exit within ${String(timeoutMs)}ms`);
}
