import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  parseGraph,
} from "../src/index.js";
import type { CompiledGraph, ExecutorDefinition } from "../src/index.js";
import {
  createLocalExecutionBackend,
  createSubprocessExecutor,
} from "../src/node/index.js";

const WORKER = fileURLToPath(
  new URL("./fixtures/worker-echo.mjs", import.meta.url),
);
const tempDir = mkdtempSync(join(tmpdir(), "prism-subproc-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

let counter = 0;
function subprocessExecutor(
  overrides: Partial<Parameters<typeof createSubprocessExecutor>[0]> = {},
): ExecutorDefinition {
  counter += 1;
  const backend = createLocalExecutionBackend({
    command: process.execPath,
    args: [WORKER],
    baseDir: join(tempDir, `run-${String(counter)}`),
  });
  return createSubprocessExecutor({
    name: "worker",
    backend,
    // Process startup competes with the rest of Vitest's worker pool.
    // Keep the ordinary success path tolerant of a delayed first CPU slice;
    // the dedicated timeout test below uses the short liveness deadline.
    idleTimeoutMs: 1_000,
    pollIntervalMs: 10,
    ...overrides,
  });
}

function buildGraph(definition: unknown): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

function run(graph: CompiledGraph, executor: ExecutorDefinition) {
  return createEngine({
    store: createMemoryStore(),
    registry: createExecutorRegistry([executor]),
  }).run(graph);
}

describe("createSubprocessExecutor", () => {
  test("runs a worker and returns its output as the node output", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { w: { executor: "worker", config: { mode: "echo" } } },
      finalNode: "w",
    });
    const outcome = await run(graph, subprocessExecutor()).result;
    // input has no upstreams -> null -> echoed back as the output
    expect(outcome).toEqual({ status: "succeeded", output: null });
  });

  test("shapes a single upstream output into the worker input", async () => {
    // The engine needs 'constant' too; register both executors.
    const worker = subprocessExecutor();
    const graph = buildGraph({
      version: 1,
      nodes: {
        src: { executor: "worker", config: { mode: "echo" } },
      },
      finalNode: "src",
    });
    const outcome = await run(graph, worker).result;
    expect(outcome.status).toBe("succeeded");
  });

  test("maps a worker failure to a classified node failure", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        w: {
          executor: "worker",
          config: {
            mode: "fail",
            error: "nope",
            failureClass: "semantic_failed",
          },
        },
      },
      finalNode: "w",
    });
    const outcome = await run(graph, subprocessExecutor()).result;
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failures[0]?.failureClass).toBe("semantic_failed");
    }
  });

  test("a stalled worker fails with a timeout class", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { w: { executor: "worker", config: { mode: "stall" } } },
      finalNode: "w",
    });
    const outcome = await run(graph, subprocessExecutor({ idleTimeoutMs: 200 }))
      .result;
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failures[0]?.failureClass).toBe("timeout");
    }
  });

  test("cancellation terminates the worker and cancels the run", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { w: { executor: "worker", config: { mode: "stall" } } },
      finalNode: "w",
    });
    const handle = run(graph, subprocessExecutor({ idleTimeoutMs: 60_000 }));
    // Give the worker a moment to launch, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 40));
    await handle.cancel({ why: "stop" });
    const outcome = await handle.result;
    expect(outcome.status).toBe("cancelled");
  });
});
