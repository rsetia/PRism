import { describe, expect, test } from "vitest";
import {
  abortRun,
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createManualClock,
  createMemoryStore,
  inspectRun,
  parseGraph,
  resetRun,
} from "../src/index.js";
import type {
  CompiledGraph,
  ExecutorDefinition,
  ManualClock,
  NodeState,
  RunStore,
} from "../src/index.js";

function buildGraph(definition: unknown): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

function stateOf(
  nodes: readonly { nodeId: string; state: NodeState }[],
  nodeId: string,
): NodeState | undefined {
  return nodes.find((n) => n.nodeId === nodeId)?.state;
}

function engineOn(
  store: RunStore,
  extra: readonly ExecutorDefinition[] = [],
  clock?: ManualClock,
) {
  return createEngine({
    store,
    registry: createExecutorRegistry([...builtinExecutors, ...extra]),
    ...(clock === undefined ? {} : { clock }),
  });
}

const linear = () =>
  buildGraph({
    version: 1,
    nodes: {
      first: { executor: "constant", config: { value: "hi" } },
      second: { executor: "passthrough", dependsOn: ["first"] },
    },
    finalNode: "second",
  });

describe("abortRun", () => {
  test("forces an interrupted run to a finished, cancelled state", async () => {
    const store = createMemoryStore();
    const graph = buildGraph({
      version: 1,
      nodes: {
        a: { executor: "constant", config: { value: null } },
        b: { executor: "passthrough", dependsOn: ["a"] },
      },
      finalNode: "b",
    });
    await store.createRun({ runId: "stuck", graph });
    await store.appendEvents("stuck", [
      { kind: "node_ready", nodeId: "a" },
      { kind: "node_started", nodeId: "a" },
    ]);

    await abortRun(store, "stuck");
    const inspection = await inspectRun(store, "stuck");
    expect(inspection.finished).toBe(true);
    expect(stateOf(inspection.nodes, "a")).toBe("cancelled");
    expect(stateOf(inspection.nodes, "b")).toBe("cancelled");
    expect((await store.getRun("stuck"))?.outcome).toEqual({
      status: "cancelled",
      reason: null,
      failures: [],
    });
  });

  test("holds and passes a coordinator lease to abort mutations", async () => {
    const base = createMemoryStore();
    await base.createRun({ runId: "fenced-abort", graph: linear() });
    let appendFenced = false;
    let finishFenced = false;
    const store: RunStore = {
      ...base,
      appendEvents(runId, events, expectedRevision, lease) {
        appendFenced = lease?.kind === "coordinator";
        return base.appendEvents(runId, events, expectedRevision, lease);
      },
      finishRun(runId, outcome, lease) {
        finishFenced = lease?.kind === "coordinator";
        return base.finishRun(runId, outcome, lease);
      },
    };

    await abortRun(store, "fenced-abort");
    expect(appendFenced).toBe(true);
    expect(finishFenced).toBe(true);
    expect(await base.getRunLeases("fenced-abort")).toEqual([]);
  });

  test("rejects an abort while a coordinator owns the run", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "owned", graph: linear() });
    await store.acquireCoordinatorLease("owned", "engine", 30_000);
    await expect(abortRun(store, "owned")).rejects.toThrow(
      "active coordinator lease",
    );
  });

  test("preserves failures that happened before an administrative abort", async () => {
    const store = createMemoryStore();
    const graph = buildGraph({
      version: 1,
      nodes: {
        doomed: { executor: "fail" },
        pending: { executor: "constant", config: { value: null } },
      },
      finalNode: "pending",
    });
    const failure = {
      nodeId: "doomed",
      cause: { reason: "already failed" },
      failureClass: "semantic_failed" as const,
    };
    await store.createRun({ runId: "partial", graph });
    await store.appendEvents("partial", [
      { kind: "node_ready", nodeId: "doomed" },
      { kind: "node_started", nodeId: "doomed" },
      { kind: "node_failed", nodeId: "doomed", failure },
    ]);

    await abortRun(store, "partial");
    expect((await store.getRun("partial"))?.outcome).toEqual({
      status: "cancelled",
      reason: null,
      failures: [failure],
    });
  });

  test("rejects an unknown run and no-ops a finished run", async () => {
    const store = createMemoryStore();
    await expect(abortRun(store, "nope")).rejects.toThrow();

    await engineOn(store).run(linear(), { runId: "done" }).result;
    await abortRun(store, "done"); // already finished — no throw
    const inspection = await inspectRun(store, "done");
    expect(stateOf(inspection.nodes, "second")).toBe("succeeded");
  });
});

describe("resetRun", () => {
  test("rejects a reset while a coordinator owns the run", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "owned", graph: linear() });
    await store.acquireCoordinatorLease("owned", "engine", 30_000);
    await expect(resetRun(store, "owned", ["first"])).rejects.toThrow(
      "active coordinator lease",
    );
  });

  test("reset + resume re-runs a succeeded node", async () => {
    const store = createMemoryStore();
    let firstCalls = 0;
    const counting: ExecutorDefinition = {
      name: "counting",
      execute() {
        firstCalls += 1;
        return { status: "succeeded", output: `run-${String(firstCalls)}` };
      },
    };
    const graph = buildGraph({
      version: 1,
      nodes: { only: { executor: "counting" } },
      finalNode: "only",
    });
    await engineOn(store, [counting]).run(graph, { runId: "r" }).result;
    expect(firstCalls).toBe(1);

    await resetRun(store, "r", ["only"]);
    const afterReset = await inspectRun(store, "r");
    expect(afterReset.finished).toBe(false);
    expect(stateOf(afterReset.nodes, "only")).toBe("pending");

    const outcome = await engineOn(store, [counting]).resume("r").result;
    expect(outcome).toEqual({ status: "succeeded", output: "run-2" });
    expect(firstCalls).toBe(2);
  });

  test("holds and passes a coordinator lease to reset mutations", async () => {
    const base = createMemoryStore();
    await engineOn(base).run(linear(), { runId: "fenced-reset" }).result;
    let reopenFenced = false;
    let appendFenced = false;
    const store: RunStore = {
      ...base,
      reopenRun(runId, lease) {
        reopenFenced = lease?.kind === "coordinator";
        return base.reopenRun(runId, lease);
      },
      appendEvents(runId, events, expectedRevision, lease) {
        appendFenced = lease?.kind === "coordinator";
        return base.appendEvents(runId, events, expectedRevision, lease);
      },
    };

    await resetRun(store, "fenced-reset", ["first"]);
    expect(reopenFenced).toBe(true);
    expect(appendFenced).toBe(true);
    expect(await base.getRunLeases("fenced-reset")).toEqual([]);
  });

  test("includeDownstream resets transitive dependents", async () => {
    const store = createMemoryStore();
    const graph = buildGraph({
      version: 1,
      nodes: {
        a: { executor: "constant", config: { value: "a" } },
        b: { executor: "passthrough", dependsOn: ["a"] },
        c: { executor: "passthrough", dependsOn: ["b"] },
      },
      finalNode: "c",
    });
    await engineOn(store).run(graph, { runId: "r" }).result;

    await resetRun(store, "r", ["a"], { includeDownstream: true });
    const inspection = await inspectRun(store, "r");
    expect(stateOf(inspection.nodes, "a")).toBe("pending");
    expect(stateOf(inspection.nodes, "b")).toBe("pending");
    expect(stateOf(inspection.nodes, "c")).toBe("pending");
  });

  test("resetting one node leaves its dependents untouched", async () => {
    const store = createMemoryStore();
    const graph = buildGraph({
      version: 1,
      nodes: {
        a: { executor: "constant", config: { value: "a" } },
        b: { executor: "passthrough", dependsOn: ["a"] },
      },
      finalNode: "b",
    });
    await engineOn(store).run(graph, { runId: "r" }).result;

    await resetRun(store, "r", ["a"]);
    const inspection = await inspectRun(store, "r");
    expect(stateOf(inspection.nodes, "a")).toBe("pending");
    expect(stateOf(inspection.nodes, "b")).toBe("succeeded");
  });

  test("reset clears a failed node's recorded failure", async () => {
    const store = createMemoryStore();
    const graph = buildGraph({
      version: 1,
      nodes: { doomed: { executor: "fail", config: { reason: "boom" } } },
      finalNode: "doomed",
    });
    await engineOn(store).run(graph, { runId: "r" }).result;
    expect((await inspectRun(store, "r")).failures).toHaveLength(1);

    await resetRun(store, "r", ["doomed"]);
    const inspection = await inspectRun(store, "r");
    expect(inspection.failures).toEqual([]);
    expect(stateOf(inspection.nodes, "doomed")).toBe("pending");
  });

  test("rejects an unknown run or node", async () => {
    const store = createMemoryStore();
    await expect(resetRun(store, "nope", ["only"])).rejects.toThrow();
    await engineOn(store).run(linear(), { runId: "r" }).result;
    await expect(resetRun(store, "r", ["ghost"])).rejects.toThrow();
  });

  test("a reset retried node re-runs with a fresh attempt budget", async () => {
    const store = createMemoryStore();
    const clock = createManualClock();
    let calls = 0;
    const flaky: ExecutorDefinition = {
      name: "flaky",
      execute() {
        calls += 1;
        return { status: "succeeded", output: calls };
      },
    };
    const graph = buildGraph({
      version: 1,
      nodes: { n: { executor: "flaky" } },
      finalNode: "n",
    });
    await engineOn(store, [flaky], clock).run(graph, { runId: "r" }).result;
    expect(calls).toBe(1);

    await resetRun(store, "r", ["n"]);
    const outcome = await engineOn(store, [flaky], clock).resume("r").result;
    expect(outcome).toEqual({ status: "succeeded", output: 2 });
  });
});
