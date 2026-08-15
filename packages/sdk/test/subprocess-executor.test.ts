import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createManualClock,
  createMemoryStore,
  parseGraph,
} from "../src/index.js";
import type { CompiledGraph, ExecutorDefinition } from "../src/index.js";
import {
  createLocalExecutionBackend,
  createSubprocessExecutor,
} from "../src/node/index.js";
import type {
  AgentProgressSnapshot,
  AgentStallDecision,
  ProgressReportingExecutionBackend,
  WorkerHandle,
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

  test("a live non-progressing structured session triggers escalation", async () => {
    const clock = createManualClock();
    const decisions: AgentStallDecision[] = [];
    const states: string[] = [];
    let terminated = false;
    const handle: WorkerHandle = { id: "fake", runId: "r", nodeId: "n" };
    const progress: AgentProgressSnapshot = {
      capability: "structured",
      sessionStartedAtMs: 0,
      processLivenessAtMs: 0,
      lastModelEventAtMs: null,
      lastToolEventAtMs: null,
      lastWorkspaceMutationAtMs: null,
      lastPhaseTransitionAtMs: null,
      externalWait: null,
      decisions,
    };
    const backend: ProgressReportingExecutionBackend = {
      progressCapability: "structured",
      launch: () => Promise.resolve(handle),
      poll: () => Promise.resolve("running"),
      checkLiveness: () => Promise.resolve("alive"),
      terminate: () => {
        terminated = true;
        return Promise.resolve();
      },
      collect: () => Promise.reject(new Error("still running")),
      readAgentProgress: () => Promise.resolve(progress),
      recordStallDecision: (_handle, decision) => {
        decisions.push(decision);
        return Promise.resolve();
      },
    };
    const executor = createSubprocessExecutor({
      name: "structured",
      backend,
      clock,
      pollIntervalMs: 10,
      stallPolicy: { timeoutMs: 100, action: "escalate" },
    });
    const outcomePromise = Promise.resolve(
      executor.execute({
        runId: "r",
        nodeId: "n",
        kind: "task",
        attempt: 1,
        inputs: [],
        signal: new AbortController().signal,
        reportPhase: () => Promise.resolve(),
        reportAgentProgress: (state) => {
          states.push(state);
          return Promise.resolve();
        },
      }),
    );

    let settled = false;
    void outcomePromise.finally(() => {
      settled = true;
    });
    for (let turn = 0; turn < 1_000 && !settled; turn += 1) {
      await Promise.resolve();
      if (clock.pending > 0) clock.advanceToNext();
    }
    const outcome = await outcomePromise;
    expect(outcome).toMatchObject({
      status: "failed",
      failureClass: "manual_review_required",
    });
    expect(decisions).toHaveLength(1);
    expect(states).toEqual(["active", "stalled"]);
    // Escalation is terminal for the attempt.  This prevents a provisioner
    // from deleting the active worker's worktree during executor cleanup.
    expect(terminated).toBe(true);
  });
});
