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
  let timestampMs = 0;
  const store = createMemoryStore({
    now: () => {
      const current = timestampMs;
      timestampMs += 10;
      return current;
    },
  });
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

  test("recognizes structured evidence while preserving generic output", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { work: { executor: "constant" } },
      finalNode: "work",
    });
    const proof = {
      version: 1,
      summary: "Evidence is inspectable",
      commits: [{ sha: "abc123" }],
      pullRequests: [],
      validations: [{ command: "npm test", status: "passed" }],
      reviewVerdicts: [],
      screenshots: [],
      artifacts: [],
      unresolvedRisks: [],
    } as const;
    const store = await createStoredRun(graph, "evidence", [
      { kind: "node_ready", nodeId: "work" },
      { kind: "node_started", nodeId: "work" },
      { kind: "node_succeeded", nodeId: "work", output: proof },
    ]);

    expect((await inspectRun(store, "evidence")).nodes[0]?.evidence).toEqual(
      proof,
    );
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
    expect(inspection.nodes).toEqual([
      { nodeId: "ghost", state: "pending", timing: null, evidence: null },
    ]);
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

  test("attributes node wall time across queue and reported phases", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { work: { executor: "constant", config: { value: null } } },
      finalNode: "work",
    });
    const store = await createStoredRun(graph, "timed", [
      { kind: "node_ready", nodeId: "work" },
      { kind: "node_started", nodeId: "work" },
      {
        kind: "node_phase_changed",
        nodeId: "work",
        phase: "validation",
      },
      { kind: "node_succeeded", nodeId: "work", output: null },
    ]);

    const inspection = await inspectRun(store, "timed");
    expect(inspection.nodes[0]?.timing).toEqual({
      startedAtMs: 0,
      completedAtMs: 30,
      totalDurationMs: 30,
      attributedDurationMs: 30,
      unattributedDurationMs: 0,
      phases: [
        { phase: "dependency_wait", durationMs: 0 },
        { phase: "scheduler_queue", durationMs: 10 },
        { phase: "execution", durationMs: 10 },
        { phase: "validation", durationMs: 10 },
      ],
    });
    expect(inspection.timing).toMatchObject({
      startedAtMs: 0,
      completedAtMs: null,
      totalDurationMs: 30,
      attributionCoverage: 1,
      criticalPath: {
        nodeIds: ["work"],
        durationMs: 30,
      },
    });
  });

  test("identifies the longest weighted dependency path", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        long: { executor: "constant" },
        short: { executor: "constant" },
        final: {
          executor: "constant",
          dependsOn: ["long", "short"],
        },
      },
      finalNode: "final",
    });
    const store = await createStoredRun(graph, "critical", [
      { kind: "node_ready", nodeId: "long" },
      { kind: "node_started", nodeId: "long" },
      {
        kind: "node_phase_changed",
        nodeId: "long",
        phase: "implementation",
      },
      { kind: "node_succeeded", nodeId: "long", output: null },
      { kind: "node_ready", nodeId: "short" },
      { kind: "node_started", nodeId: "short" },
      { kind: "node_succeeded", nodeId: "short", output: null },
      { kind: "node_ready", nodeId: "final" },
      { kind: "node_started", nodeId: "final" },
      { kind: "node_succeeded", nodeId: "final", output: null },
    ]);

    const inspection = await inspectRun(store, "critical");
    expect(inspection.timing?.criticalPath).toMatchObject({
      nodeIds: ["long", "final"],
      durationMs: 50,
    });
    expect(inspection.timing?.waitingPhases[0]).toMatchObject({
      phase: "dependency_wait",
    });
  });

  test("reports resource contention separately from critical-path work", async () => {
    const graph = buildGraph({
      version: 1,
      resources: { shared: { capacity: 1 } },
      nodes: {
        work: { executor: "constant", resources: ["shared"] },
      },
      finalNode: "work",
    });
    const store = await createStoredRun(graph, "resource-timing", [
      { kind: "node_ready", nodeId: "work" },
      {
        kind: "node_resource_wait",
        nodeId: "work",
        resourceIds: ["shared"],
      },
      { kind: "node_started", nodeId: "work" },
      { kind: "node_succeeded", nodeId: "work", output: null },
    ]);

    const inspection = await inspectRun(store, "resource-timing");
    expect(inspection.nodes[0]?.timing?.phases).toContainEqual({
      phase: "resource_contention",
      durationMs: 10,
    });
    expect(inspection.timing?.waitingPhases).toContainEqual({
      phase: "resource_contention",
      durationMs: 10,
    });
    expect(inspection.timing?.criticalPath).toMatchObject({
      nodeIds: ["work"],
      durationMs: 20,
    });
    expect(inspection.timing?.criticalPath.phases).not.toContainEqual(
      expect.objectContaining({ phase: "resource_contention" }),
    );
  });

  test("keeps usage from retried attempts and derives only labelled estimated cost", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        first: { executor: "constant" },
        second: { executor: "constant" },
      },
      finalNode: "second",
    });
    const store = await createStoredRun(graph, "metered", [
      { kind: "node_ready", nodeId: "first" },
      { kind: "node_ready", nodeId: "second" },
      { kind: "node_started", nodeId: "first" },
      { kind: "node_started", nodeId: "second" },
      {
        kind: "node_usage_reported",
        nodeId: "first",
        attempt: 1,
        usage: {
          provider: "fake",
          model: "v1",
          inputTokens: 10,
          outputTokens: 2,
          agentTurns: 1,
          toolCalls: 1,
          rateLimited: true,
        },
      },
      {
        kind: "node_retry_wait",
        nodeId: "first",
        attempt: 1,
        delayMs: 1,
        failure: { nodeId: "first", cause: "retry" },
      },
      { kind: "node_succeeded", nodeId: "second", output: null },
      { kind: "node_ready", nodeId: "first" },
      { kind: "node_started", nodeId: "first" },
      {
        kind: "node_usage_reported",
        nodeId: "first",
        attempt: 2,
        usage: {
          provider: "fake",
          model: "v1",
          inputTokens: 20,
          outputTokens: 3,
          cachedTokens: 5,
          agentTurns: 1,
        },
      },
      { kind: "node_succeeded", nodeId: "first", output: null },
    ]);

    const inspection = await inspectRun(store, "metered", {
      prices: [
        {
          version: "fake-2026",
          provider: "fake",
          model: "v1",
          inputPerMillion: 1,
          outputPerMillion: 2,
          cachedPerMillion: 0.5,
        },
      ],
    });
    expect(inspection.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
      cachedTokens: 5,
      agentTurns: 2,
      toolCalls: 1,
      costKind: "estimated",
      priceVersion: "fake-2026",
    });
    expect(
      inspection.usage?.attempts.map((attempt) => attempt.attempt),
    ).toEqual([1, 2]);
    expect(inspection.scheduler?.maximumRealizedNodeConcurrency).toBe(2);
  });

  test("charges an in-progress phase up to the run's latest observed event", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        slow: { executor: "constant", config: { value: null } },
        ticker: { executor: "constant", config: { value: null } },
      },
      finalNode: "ticker",
    });
    // slow enters execution at t=10 and then goes silent; ticker keeps the
    // run's clock moving to t=30.
    const store = await createStoredRun(graph, "in-progress", [
      { kind: "node_ready", nodeId: "slow" },
      { kind: "node_started", nodeId: "slow" },
      { kind: "node_ready", nodeId: "ticker" },
      { kind: "node_started", nodeId: "ticker" },
    ]);

    const inspection = await inspectRun(store, "in-progress");
    const slow = inspection.nodes.find((node) => node.nodeId === "slow");
    expect(slow?.timing).toEqual({
      startedAtMs: 0,
      completedAtMs: null,
      totalDurationMs: 30,
      attributedDurationMs: 30,
      unattributedDurationMs: 0,
      phases: [
        { phase: "dependency_wait", durationMs: 0 },
        { phase: "scheduler_queue", durationMs: 10 },
        { phase: "execution", durationMs: 20 },
      ],
    });
  });

  test("reports timing as unavailable for legacy timestamp-free logs", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { work: { executor: "constant", config: { value: null } } },
      finalNode: "work",
    });
    const base = await createStoredRun(graph, "legacy-timing", [
      { kind: "node_ready", nodeId: "work" },
      { kind: "node_started", nodeId: "work" },
      { kind: "node_succeeded", nodeId: "work", output: null },
    ]);
    const legacy: RunStore = {
      ...base,
      readEvents(runId, fromSeq) {
        const source = base.readEvents(runId, fromSeq);
        return (async function* withoutTimestamps() {
          for await (const event of source) {
            yield { ...event, timestampMs: null };
          }
        })();
      },
    };

    const inspection = await inspectRun(legacy, "legacy-timing");
    expect(inspection.nodes[0]?.timing).toBeNull();
    expect(inspection.timing).toBeNull();
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
