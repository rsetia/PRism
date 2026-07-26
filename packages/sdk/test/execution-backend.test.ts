import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { createLocalExecutionBackend } from "../src/node/index.js";
import type { ExecutionBackend, WorkerSpec } from "../src/node/index.js";

const WORKER = fileURLToPath(
  new URL("./fixtures/worker-echo.mjs", import.meta.url),
);

const tempDir = mkdtempSync(join(tmpdir(), "prism-backend-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

let counter = 0;
function backend(): ExecutionBackend {
  counter += 1;
  return createLocalExecutionBackend({
    command: process.execPath,
    args: [WORKER],
    baseDir: join(tempDir, `b-${String(counter)}`),
  });
}

function spec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    runId: "r",
    nodeId: "n",
    kind: "task",
    executor: "echo",
    input: "hello",
    config: null,
    attempt: 1,
    ...overrides,
  };
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(
  b: ExecutionBackend,
  handle: Awaited<ReturnType<ExecutionBackend["launch"]>>,
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if ((await b.poll(handle)) === "exited") return;
    await settle(10);
  }
  throw new Error("worker did not exit in time");
}

describe("createLocalExecutionBackend", () => {
  test("launches a worker and collects its echoed output", async () => {
    const b = backend();
    const handle = await b.launch(spec({ input: { greeting: "hi" } }));
    expect(handle.runId).toBe("r");
    expect(handle.nodeId).toBe("n");
    await waitForExit(b, handle);
    const result = await b.collect(handle);
    expect(result).toEqual({
      status: "succeeded",
      output: { greeting: "hi" },
    });
  });

  test("collects a worker-reported failure with its class", async () => {
    const b = backend();
    const handle = await b.launch(
      spec({
        config: {
          mode: "fail",
          error: "boom",
          failureClass: "semantic_failed",
        },
      }),
    );
    await waitForExit(b, handle);
    const result = await b.collect(handle);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("expected worker failure");
    }
    expect(result.error).toBe("boom");
    expect(result.failureClass).toBe("semantic_failed");
  });

  test("poll reports running before exit", async () => {
    const b = backend();
    const handle = await b.launch(spec({ config: { mode: "stall" } }));
    await settle(20);
    expect(await b.poll(handle)).toBe("running");
    await b.terminate(handle);
  });

  test("a stalled worker reads as idle past the timeout", async () => {
    const b = backend();
    const handle = await b.launch(spec({ config: { mode: "stall" } }));
    await settle(30);
    const now = Date.now() + 10_000; // pretend 10s elapsed since the beat
    expect(await b.checkLiveness(handle, { idleTimeoutMs: 1_000, now })).toBe(
      "idle",
    );
    await b.terminate(handle);
  });

  test("terminate stops a stalled worker", async () => {
    const b = backend();
    const handle = await b.launch(spec({ config: { mode: "stall" } }));
    await settle(20);
    await b.terminate(handle);
    expect(await b.poll(handle)).toBe("exited");
  });

  test("collecting a worker that left no result rejects", async () => {
    const b = backend();
    const handle = await b.launch(spec({ config: { mode: "stall" } }));
    await settle(20);
    await b.terminate(handle);
    await expect(b.collect(handle)).rejects.toThrow();
  });
});
