import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { createLocalExecutionBackend } from "../src/node/index.js";
import type { ExecutionBackend, WorkerSpec } from "../src/node/index.js";
import { runExecutionBackendContract } from "../src/testing/index.js";

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
  instance: ExecutionBackend,
  handle: Awaited<ReturnType<ExecutionBackend["launch"]>>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await instance.poll(handle)) === "exited") return;
    await settle(10);
  }
  throw new Error("worker did not exit in time");
}

runExecutionBackendContract("createLocalExecutionBackend", () => backend());

describe("createLocalExecutionBackend file protocol", () => {
  test("exposes its local protocol directory and serializes the worker spec", async () => {
    const instance = backend();
    const workerSpec = spec({
      runId: "run/with spaces",
      nodeId: "node:one",
      config: { mode: "stall" },
    });
    const handle = await instance.launch(workerSpec);

    expect(handle.nodeDir).toBeDefined();
    if (handle.nodeDir === undefined) {
      throw new Error("local backend did not expose its protocol directory");
    }
    expect(isAbsolute(handle.nodeDir)).toBe(true);
    expect(
      JSON.parse(readFileSync(join(handle.nodeDir, "spec.json"), "utf8")),
    ).toEqual(workerSpec);

    await instance.terminate(handle);
  });

  test("creates protocol files inside a supplied workspace", async () => {
    const instance = backend();
    const workspace = mkdtempSync(join(tempDir, "workspace-"));
    const handle = await instance.launch(spec({ input: "workspace" }), {
      cwd: workspace,
    });

    expect(handle.nodeDir).toBeDefined();
    if (handle.nodeDir === undefined) {
      throw new Error("local backend did not expose its protocol directory");
    }
    expect(
      resolve(handle.nodeDir).startsWith(`${resolve(workspace)}${sep}`),
    ).toBe(true);

    await waitForExit(instance, handle);
    await expect(instance.collect(handle)).resolves.toEqual({
      status: "succeeded",
      output: "workspace",
    });
  });
});
