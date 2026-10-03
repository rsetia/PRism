import { describe, expect, test } from "vitest";
import {
  combineReviewRounds,
  compileGraph,
  computeRunStats,
  createMemoryStore,
  parseGraph,
  readRunStats,
} from "../src/index.js";
import type {
  CompiledGraph,
  NodePhase,
  PersistedRunEvent,
  RunEvent,
} from "../src/index.js";

const MINUTE = 60_000;

function buildGraph(definition: unknown): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

/**
 * context-a -> implement-a -> merge-a -> implement-b, with implement-c
 * running in parallel off context-a and finishing early.
 */
const graph = buildGraph({
  version: 1,
  nodes: {
    "context-a": { executor: "constant", dependsOn: [] },
    "implement-a": { executor: "implement", dependsOn: ["context-a"] },
    "merge-a": { executor: "merge_resolve", dependsOn: ["implement-a"] },
    "implement-b": { executor: "implement", dependsOn: ["merge-a"] },
    "implement-c": { executor: "implement", dependsOn: ["context-a"] },
    done: {
      executor: "constant",
      dependsOn: ["implement-b", "implement-c"],
    },
  },
});

/** Build a timed log from [minute, event] pairs. */
function log(
  entries: readonly (readonly [number | null, RunEvent])[],
): PersistedRunEvent[] {
  return entries.map(([minute, event], seq) => ({
    ...event,
    seq,
    timestampMs: minute === null ? null : minute * MINUTE,
  }));
}

const ready = (nodeId: string): RunEvent => ({ kind: "node_ready", nodeId });
const started = (nodeId: string): RunEvent => ({
  kind: "node_started",
  nodeId,
});
const phase = (nodeId: string, value: NodePhase): RunEvent => ({
  kind: "node_phase_changed",
  nodeId,
  phase: value,
});
const succeeded = (nodeId: string): RunEvent => ({
  kind: "node_succeeded",
  nodeId,
  output: null,
});
const failed = (nodeId: string): RunEvent => ({
  kind: "node_failed",
  nodeId,
  failure: { nodeId, cause: "boom" },
});
const reset = (nodeId: string): RunEvent => ({ kind: "node_reset", nodeId });

/** A run where implement-a fails, sits idle for 40 minutes, then resumes. */
const events = log([
  [0, ready("context-a")],
  [0, started("context-a")],
  [0, succeeded("context-a")],
  [0, ready("implement-a")],
  [0, ready("implement-c")],
  [0, started("implement-a")],
  [0, started("implement-c")],
  [0, phase("implement-a", "implementation")],
  [0, phase("implement-c", "implementation")],
  [10, phase("implement-a", "review_wait")],
  // The adjudicator re-reports the active phase on every poll.
  [11, phase("implement-a", "review_wait")],
  [12, phase("implement-a", "review_wait")],
  [14, phase("implement-a", "implementation")],
  [15, succeeded("implement-c")],
  [16, failed("implement-a")],
  // Nothing runs until an operator resets the node at minute 56.
  [56, reset("implement-a")],
  [56, ready("implement-a")],
  [56, started("implement-a")],
  [56, phase("implement-a", "review_wait")],
  [60, succeeded("implement-a")],
  [60, ready("merge-a")],
  [60, started("merge-a")],
  [60, phase("merge-a", "merge")],
  [61, succeeded("merge-a")],
  [61, ready("implement-b")],
  [61, started("implement-b")],
  [61, phase("implement-b", "implementation")],
  [70, phase("implement-b", "review_wait")],
  [75, phase("implement-b", "implementation")],
  [77, phase("implement-b", "review_wait")],
  [80, succeeded("implement-b")],
  [80, ready("done")],
  [80, started("done")],
  [80, succeeded("done")],
]);

describe("computeRunStats", () => {
  const stats = computeRunStats(graph, events);
  if (stats === null) throw new Error("expected stats");

  test("measures wall time from the first to the last event", () => {
    expect(stats.wallMs).toBe(80 * MINUTE);
    expect(stats.untimedEventCount).toBe(0);
  });

  test("walks the critical path back through the dependency that finished last", () => {
    expect(stats.criticalPath.nodeIds).toEqual([
      "context-a",
      "implement-a",
      "merge-a",
      "implement-b",
      "done",
    ]);
    expect(stats.criticalPath.implementNodeCount).toBe(2);
  });

  test("sums the path's phases across attempts, leaving operator waits outside", () => {
    const byPhase = Object.fromEntries(
      stats.criticalPath.phases.map((entry) => [entry.phase, entry.durationMs]),
    );
    // implement-a: 10 + 2 implementation, 4 + 4 review_wait;
    // implement-b: 9 + 2 implementation, 5 + 3 review_wait; merge-a: 1 merge.
    expect(byPhase).toEqual({
      implementation: 23 * MINUTE,
      review_wait: 16 * MINUTE,
      merge: 1 * MINUTE,
      execution: 0,
    });
    expect(stats.criticalPath.attributedMs).toBe(40 * MINUTE);
    const shares = stats.criticalPath.phases.reduce(
      (sum, entry) => sum + entry.share,
      0,
    );
    expect(shares).toBeCloseTo(1);
  });

  test("treats repeated reports of the active phase as one interval", () => {
    const review = stats.phases.find((entry) => entry.phase === "review_wait");
    expect(review).toEqual({
      phase: "review_wait",
      count: 4,
      medianMs: 4 * MINUTE,
      p90Ms: 5 * MINUTE,
      totalMs: 16 * MINUTE,
    });
  });

  test("counts review rounds as entries into review_wait", () => {
    expect(stats.reviewRounds).toEqual({
      nodes: [
        { nodeId: "implement-a", rounds: 2 },
        { nodeId: "implement-b", rounds: 2 },
      ],
      mean: 2,
      max: 2,
    });
  });

  test("reports silences with no worker running and what ended them", () => {
    expect(stats.idle.totalMs).toBe(40 * MINUTE);
    expect(stats.idle.gaps).toEqual([
      {
        startedAtMs: 16 * MINUTE,
        durationMs: 40 * MINUTE,
        endedBy: { kind: "node_reset", nodeId: "implement-a" },
      },
    ]);
  });

  test("does not count a silence while a worker runs as idle", () => {
    // implement-b is silent for 9 minutes between events, but running.
    const busy = computeRunStats(graph, events, { idleThresholdMs: 1 });
    expect(
      busy?.idle.gaps.every((gap) => gap.startedAtMs !== 61 * MINUTE),
    ).toBe(true);
  });

  test("counts failure-path events and classifies merges", () => {
    expect(stats.events).toEqual({
      failed: 1,
      reset: 1,
      blocked: 0,
      cancelled: 0,
      retryWait: 0,
    });
    expect(stats.merges).toEqual({ direct: 1, agent: 0, reconciled: 0 });
  });

  test("an agent merge reports integration_update even if it also merges", () => {
    const agentMerge = computeRunStats(
      graph,
      log([
        [0, ready("merge-a")],
        [0, started("merge-a")],
        [0, phase("merge-a", "merge")],
        [1, phase("merge-a", "integration_update")],
        [2, succeeded("merge-a")],
      ]),
    );
    expect(agentMerge?.merges).toEqual({ direct: 0, agent: 1, reconciled: 0 });
  });

  test("classifies a merge by the attempt that succeeded", () => {
    const retried = computeRunStats(
      graph,
      log([
        [0, ready("merge-a")],
        [0, started("merge-a")],
        [0, phase("merge-a", "integration_update")],
        [1, failed("merge-a")],
        [2, reset("merge-a")],
        [2, ready("merge-a")],
        [2, started("merge-a")],
        [2, phase("merge-a", "merge")],
        [3, succeeded("merge-a")],
      ]),
    );
    expect(retried?.merges).toEqual({ direct: 1, agent: 0, reconciled: 0 });
  });

  test("skips events without timestamps and says how many", () => {
    const partial = computeRunStats(
      graph,
      log([
        [null, ready("context-a")],
        [null, started("context-a")],
        [5, succeeded("context-a")],
        [7, ready("implement-a")],
      ]),
    );
    expect(partial?.untimedEventCount).toBe(2);
    expect(partial?.wallMs).toBe(2 * MINUTE);
  });

  test("returns null for a log with no timestamps at all", () => {
    expect(
      computeRunStats(graph, log([[null, ready("context-a")]])),
    ).toBeNull();
    expect(computeRunStats(graph, [])).toBeNull();
  });
});

describe("combineReviewRounds", () => {
  test("weights every reviewed node across runs equally", () => {
    const first = computeRunStats(graph, events);
    const second = computeRunStats(
      graph,
      log([
        [0, ready("implement-c")],
        [0, started("implement-c")],
        [1, phase("implement-c", "review_wait")],
        [2, succeeded("implement-c")],
      ]),
    );
    if (first === null || second === null) throw new Error("expected stats");
    const combined = combineReviewRounds([first, second]);
    expect(combined.nodes.map((node) => node.rounds)).toEqual([2, 2, 1]);
    expect(combined.mean).toBeCloseTo(5 / 3);
    expect(combined.max).toBe(2);
    expect(combineReviewRounds([]).mean).toBeNull();
  });
});

describe("readRunStats", () => {
  test("reads a persisted run", async () => {
    let now = 0;
    const store = createMemoryStore({
      now: () => {
        const current = now;
        now += MINUTE;
        return current;
      },
    });
    await store.createRun({ runId: "r1", graph });
    await store.appendEvents("r1", [
      ready("context-a"),
      started("context-a"),
      succeeded("context-a"),
    ]);
    const stats = await readRunStats(store, "r1");
    expect(stats?.criticalPath.nodeIds).toEqual(["context-a"]);
    await expect(readRunStats(store, "missing")).rejects.toThrow(
      'unknown run: "missing"',
    );
  });
});
