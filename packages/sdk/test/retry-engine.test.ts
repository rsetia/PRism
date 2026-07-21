import { describe, expect, test } from "vitest";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createManualClock,
  createMemoryStore,
  parseGraph,
} from "../src/index.js";
import type {
  CompiledGraph,
  ExecutorDefinition,
  FailureClass,
  ManualClock,
  PersistedRunEvent,
  RetryPolicy,
  RunHandle,
} from "../src/index.js";

function buildGraph(definition: unknown): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

const singleNodeGraph = (executor: string): CompiledGraph =>
  buildGraph({
    version: 1,
    nodes: { n: { executor } },
    finalNode: "n",
  });

const retryPolicy = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  maxAttempts: 3,
  retryableClasses: new Set<FailureClass>(["transient_infra"]),
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  ...overrides,
});

/**
 * Fails `failuresBeforeSuccess` times with `failureClass`, then succeeds.
 * Set failures high enough and it never succeeds.
 */
function flakyExecutor(
  failuresBeforeSuccess: number,
  failureClass: FailureClass,
  name = "flaky",
): ExecutorDefinition {
  let calls = 0;
  return {
    name,
    execute() {
      calls += 1;
      if (calls <= failuresBeforeSuccess) {
        return { status: "failed", cause: { attempt: calls }, failureClass };
      }
      return { status: "succeeded", output: `ok-after-${String(calls)}` };
    },
  };
}

function harness(
  executor: ExecutorDefinition,
  policy: RetryPolicy = retryPolicy(),
): { handle: RunHandle; clock: ManualClock } {
  const clock = createManualClock();
  const engine = createEngine({
    store: createMemoryStore(),
    registry: createExecutorRegistry([...builtinExecutors, executor]),
    retryPolicy: policy,
    clock,
  });
  return { handle: engine.run(singleNodeGraph(executor.name)), clock };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Release every backoff the engine asks for until the run is terminal. */
async function drainRetries(handle: RunHandle, clock: ManualClock) {
  let done = false;
  void handle.result.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  while (!done) {
    await settle();
    clock.advanceToNext();
  }
}

async function events(handle: RunHandle): Promise<PersistedRunEvent[]> {
  const seen: PersistedRunEvent[] = [];
  for await (const event of handle.events) {
    seen.push(event);
  }
  return seen;
}

const kinds = (seen: readonly PersistedRunEvent[]): string[] =>
  seen.map((event) => event.kind);

describe("engine retry", () => {
  test("a retryable failure is retried until it succeeds", async () => {
    const { handle, clock } = harness(flakyExecutor(2, "transient_infra"));
    await drainRetries(handle, clock);

    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "ok-after-3",
    });
    expect(kinds(await events(handle))).toEqual([
      "node_ready",
      "node_started",
      "node_retry_wait",
      "node_ready",
      "node_started",
      "node_retry_wait",
      "node_ready",
      "node_started",
      "node_succeeded",
    ]);
  });

  test("retry events carry attempt and exponential delay", async () => {
    const { handle, clock } = harness(flakyExecutor(2, "transient_infra"));
    await drainRetries(handle, clock);
    await handle.result;

    const retries = (await events(handle)).filter(
      (event) => event.kind === "node_retry_wait",
    );
    expect(retries.map((event) => event.attempt)).toEqual([1, 2]);
    expect(retries.map((event) => event.delayMs)).toEqual([100, 200]);
    expect(retries[0]?.failure).toEqual({
      nodeId: "n",
      cause: { attempt: 1 },
      failureClass: "transient_infra",
    });
  });

  test("exhausting maxAttempts fails with the last failure", async () => {
    const { handle, clock } = harness(flakyExecutor(99, "transient_infra"));
    await drainRetries(handle, clock);

    await expect(handle.result).resolves.toEqual({
      status: "failed",
      failures: [
        {
          nodeId: "n",
          cause: { attempt: 3 },
          failureClass: "transient_infra",
        },
      ],
    });
    expect(kinds(await events(handle))).toEqual([
      "node_ready",
      "node_started",
      "node_retry_wait",
      "node_ready",
      "node_started",
      "node_retry_wait",
      "node_ready",
      "node_started",
      "node_failed",
    ]);
  });

  test("a non-retryable class fails immediately", async () => {
    const { handle, clock } = harness(flakyExecutor(99, "semantic_failed"));
    await drainRetries(handle, clock);

    const outcome = await handle.result;
    expect(outcome.status).toBe("failed");
    expect(kinds(await events(handle))).toEqual([
      "node_ready",
      "node_started",
      "node_failed",
    ]);
  });

  test("the default policy retries nothing", async () => {
    const executor = flakyExecutor(99, "transient_infra");
    const engine = createEngine({
      store: createMemoryStore(),
      registry: createExecutorRegistry([...builtinExecutors, executor]),
    });
    const handle = engine.run(singleNodeGraph(executor.name));

    const outcome = await handle.result;
    expect(outcome.status).toBe("failed");
    expect(kinds(await events(handle))).not.toContain("node_retry_wait");
  });

  test("downstream nodes wait through retries, then run once", async () => {
    const flaky = flakyExecutor(1, "transient_infra");
    const clock = createManualClock();
    const engine = createEngine({
      store: createMemoryStore(),
      registry: createExecutorRegistry([...builtinExecutors, flaky]),
      retryPolicy: retryPolicy(),
      clock,
    });
    const handle = engine.run(
      buildGraph({
        version: 1,
        nodes: {
          first: { executor: "flaky" },
          second: { executor: "passthrough", dependsOn: ["first"] },
        },
        finalNode: "second",
      }),
    );
    await drainRetries(handle, clock);

    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "ok-after-2",
    });
    const downstream = (await events(handle)).filter(
      (event) => event.nodeId === "second",
    );
    expect(kinds(downstream)).toEqual([
      "node_ready",
      "node_started",
      "node_succeeded",
    ]);
  });

  test("cancelling during retry_wait cancels the node", async () => {
    const { handle, clock } = harness(flakyExecutor(99, "transient_infra"));

    // Let the first attempt fail and the engine settle into its backoff.
    while (clock.pending === 0) {
      await settle();
    }

    await handle.cancel({ why: "stop waiting" });
    await expect(handle.result).resolves.toEqual({
      status: "cancelled",
      reason: { why: "stop waiting" },
      failures: [],
    });

    const seen = kinds(await events(handle));
    expect(seen).toContain("node_retry_wait");
    expect(seen).toContain("node_cancelled");
    expect(seen).not.toContain("node_failed");
  });

  test("createEngine rejects an invalid retry policy", () => {
    const base = {
      store: createMemoryStore(),
      registry: createExecutorRegistry(builtinExecutors),
    };
    for (const maxAttempts of [0, -1, 1.5]) {
      expect(() =>
        createEngine({ ...base, retryPolicy: retryPolicy({ maxAttempts }) }),
      ).toThrow();
    }
    expect(() =>
      createEngine({ ...base, retryPolicy: retryPolicy({ baseDelayMs: -1 }) }),
    ).toThrow();
  });
});
