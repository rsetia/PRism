import { describe, expect, test } from "vitest";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  inspectRun,
  parseGraph,
} from "../src/index.js";
import type {
  CompiledGraph,
  ExecutorDefinition,
  NodeState,
  RunEvent,
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

function engineOn(store: RunStore, extra: readonly ExecutorDefinition[] = []) {
  return createEngine({
    store,
    registry: createExecutorRegistry([...builtinExecutors, ...extra]),
  });
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function createStoredRun(
  graph: CompiledGraph,
  runId: string,
  events: readonly RunEvent[],
): Promise<RunStore> {
  const store = createMemoryStore();
  await store.createRun({ runId, graph });
  await store.appendEvents(runId, events);
  return store;
}

describe("inspectRun", () => {
  test("reports every node succeeded for a finished run", async () => {
    const store = createMemoryStore();
    const graph = buildGraph({
      version: 1,
      nodes: {
        first: { executor: "constant", config: { value: "hi" } },
        second: { executor: "passthrough", dependsOn: ["first"] },
      },
      finalNode: "second",
    });
    const handle = engineOn(store).run(graph, { runId: "r1" });
    await handle.result;

    const inspection = await inspectRun(store, "r1");
    expect(inspection.runId).toBe("r1");
    expect(inspection.finished).toBe(true);
    expect(stateOf(inspection.nodes, "first")).toBe("succeeded");
    expect(stateOf(inspection.nodes, "second")).toBe("succeeded");
    expect(inspection.failures).toEqual([]);
  });

  test("reports failed and blocked nodes with the originating failure", async () => {
    const store = createMemoryStore();
    const graph = buildGraph({
      version: 1,
      nodes: {
        doomed: { executor: "fail", config: { reason: "boom" } },
        after: { executor: "passthrough", dependsOn: ["doomed"] },
      },
      finalNode: "after",
    });
    await engineOn(store).run(graph, { runId: "r2" }).result;

    const inspection = await inspectRun(store, "r2");
    expect(stateOf(inspection.nodes, "doomed")).toBe("failed");
    expect(stateOf(inspection.nodes, "after")).toBe("blocked");
    expect(inspection.failures.map((f) => f.nodeId)).toEqual(["doomed"]);
  });

  test("reports a persisted preflight failure with an empty event log", async () => {
    const store = createMemoryStore();
    const graph = buildGraph({
      version: 1,
      nodes: { ghost: { executor: "missing" } },
      finalNode: "ghost",
    });
    await engineOn(store).run(graph, { runId: "preflight" }).result;

    const inspection = await inspectRun(store, "preflight");
    expect(inspection.finished).toBe(true);
    expect(inspection.nodes).toEqual([{ nodeId: "ghost", state: "pending" }]);
    expect(inspection.failures).toEqual([
      {
        nodeId: "ghost",
        cause: { code: "UNKNOWN_EXECUTOR", executor: "missing" },
      },
    ]);
  });

  test("snapshots an in-progress run without blocking", async () => {
    const store = createMemoryStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ExecutorDefinition = {
      name: "slow",
      async execute() {
        await gate;
        return { status: "succeeded", output: null };
      },
    };
    const graph = buildGraph({
      version: 1,
      nodes: {
        a: { executor: "slow" },
        b: { executor: "passthrough", dependsOn: ["a"] },
      },
      finalNode: "b",
    });
    const handle = engineOn(store, [slow]).run(graph, { runId: "r3" });
    await settle(); // let "a" start and block on the gate

    const inspection = await inspectRun(store, "r3");
    expect(inspection.finished).toBe(false);
    expect(stateOf(inspection.nodes, "a")).toBe("running");
    expect(stateOf(inspection.nodes, "b")).toBe("pending");

    release?.();
    await handle.result;
  });

  test("rejects an unknown run", async () => {
    const store = createMemoryStore();
    await expect(inspectRun(store, "nope")).rejects.toThrow(
      'unknown run: "nope"',
    );
  });

  test("replays retries and collects only the final originating failure", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { work: { executor: "constant", config: { value: null } } },
      finalNode: "work",
    });
    const retryFailure = {
      nodeId: "work",
      cause: { message: "temporary" },
      failureClass: "transient_infra" as const,
    };
    const finalFailure = {
      nodeId: "work",
      cause: { message: "permanent" },
      failureClass: "semantic_failed" as const,
    };
    const store = await createStoredRun(graph, "retry", [
      { kind: "node_ready", nodeId: "work" },
      { kind: "node_started", nodeId: "work" },
      {
        kind: "node_retry_wait",
        nodeId: "work",
        attempt: 1,
        delayMs: 10,
        failure: retryFailure,
      },
      { kind: "node_ready", nodeId: "work" },
      { kind: "node_started", nodeId: "work" },
      { kind: "node_failed", nodeId: "work", failure: finalFailure },
    ]);

    const inspection = await inspectRun(store, "retry");
    expect(stateOf(inspection.nodes, "work")).toBe("failed");
    expect(inspection.failures).toEqual([finalFailure]);
  });

  test("replays cancellation and returns an immutable ordered snapshot", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        first: { executor: "constant", config: { value: null } },
        second: { executor: "constant", config: { value: null } },
      },
      finalNode: "second",
    });
    const store = await createStoredRun(graph, "cancelled", [
      { kind: "node_ready", nodeId: "first" },
      { kind: "node_cancelled", nodeId: "first" },
      { kind: "node_cancelled", nodeId: "second" },
    ]);

    const inspection = await inspectRun(store, "cancelled");
    expect(inspection.nodes.map((node) => node.nodeId)).toEqual(graph.order);
    expect(inspection.nodes.map((node) => node.state)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.nodes)).toBe(true);
    expect(Object.isFrozen(inspection.nodes[0])).toBe(true);
    expect(Object.isFrozen(inspection.failures)).toBe(true);
  });

  test("surfaces an event targeting an unknown node", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { work: { executor: "constant", config: { value: null } } },
      finalNode: "work",
    });
    const store = await createStoredRun(graph, "unknown-node", [
      { kind: "node_ready", nodeId: "ghost" },
    ]);
    await expect(inspectRun(store, "unknown-node")).rejects.toThrow(
      'unknown node "ghost"',
    );
  });

  test("surfaces illegal transitions from a corrupt event log", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { work: { executor: "constant", config: { value: null } } },
      finalNode: "work",
    });
    const store = await createStoredRun(graph, "illegal", [
      { kind: "node_ready", nodeId: "work" },
      { kind: "node_ready", nodeId: "work" },
    ]);
    await expect(inspectRun(store, "illegal")).rejects.toThrow(
      "illegal transition",
    );
  });

  test("surfaces truncated and non-gapless event snapshots", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { work: { executor: "constant", config: { value: null } } },
      finalNode: "work",
    });
    const base = await createStoredRun(graph, "corrupt", [
      { kind: "node_ready", nodeId: "work" },
    ]);

    const truncated: RunStore = {
      ...base,
      readEvents() {
        return (async function* emptyEvents() {})();
      },
    };
    await expect(inspectRun(truncated, "corrupt")).rejects.toThrow(
      "ended before event sequence 0",
    );

    const nonGapless: RunStore = {
      ...base,
      readEvents(runId, fromSeq) {
        const source = base.readEvents(runId, fromSeq);
        return (async function* shiftedEvents() {
          for await (const event of source) {
            yield { ...event, seq: event.seq + 1 };
          }
        })();
      },
    };
    await expect(inspectRun(nonGapless, "corrupt")).rejects.toThrow(
      "expected event sequence 0, received 1",
    );
  });
});
