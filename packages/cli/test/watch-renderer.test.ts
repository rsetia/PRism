import {
  buildBeadsGraph,
  compileGraph,
  parseGraph,
  type CompiledGraph,
  type RunInspection,
} from "@rsetia/prism";
import { describe, expect, test } from "vitest";
import { renderWatchDashboard } from "../src/watch-renderer.js";

function graph(): CompiledGraph {
  const parsed = parseGraph({
    version: 1,
    nodes: {
      context: { executor: "constant" },
      implement: { executor: "passthrough", dependsOn: ["context"] },
      review: { executor: "passthrough", dependsOn: ["implement"] },
    },
    finalNode: "review",
  });
  if (!parsed.ok) throw new Error("dashboard fixture did not parse");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("dashboard fixture did not compile");
  return compiled.graph;
}

function inspection(): RunInspection {
  return {
    runId: "run-dashboard",
    finished: false,
    nodes: [
      { nodeId: "context", state: "succeeded", timing: null, evidence: null },
      { nodeId: "implement", state: "running", timing: null, evidence: null },
      { nodeId: "review", state: "pending", timing: null, evidence: null },
    ],
    failures: [],
    timing: null,
  };
}

describe("watch dashboard", () => {
  test("renders dependency waves, progress, and node states", () => {
    const output = renderWatchDashboard(graph(), inspection(), {
      columns: 90,
      color: false,
      frame: 1,
    });

    expect(output).toContain("PRISM // LIVE DAG");
    expect(output).toContain("RUN run-dashboard");
    expect(output).toContain("33% · 1/3 · 1 ACTIVE");
    expect(output).toContain("EXECUTION DAG · 3 NODES");
    expect(output).toContain("01 ROOTS");
    expect(output).toContain("02 WAVE");
    expect(output).toContain("03 WAVE");
    expect(output).toContain("✓ context");
    expect(output).toContain("▶ implement  ← context");
    expect(output).toContain("○ review  ← implement");
    expect(output).not.toContain("\u001B[");
  });

  test("uses a high-contrast highlight for running nodes", () => {
    const output = renderWatchDashboard(graph(), inspection(), {
      columns: 90,
      color: true,
    });

    expect(output).toContain("\u001B[1;30;46m▶\u001B[0m");
    expect(output).toContain("implement");
  });

  test("renders terminal failures below the DAG", () => {
    const failed: RunInspection = {
      runId: "failed-run",
      finished: true,
      nodes: [
        {
          nodeId: "context",
          state: "succeeded",
          timing: null,
          evidence: null,
        },
        {
          nodeId: "implement",
          state: "failed",
          timing: null,
          evidence: null,
        },
        {
          nodeId: "review",
          state: "blocked",
          timing: null,
          evidence: null,
        },
      ],
      failures: [
        {
          nodeId: "implement",
          cause: { message: "validation failed" },
          failureClass: "validation_failed",
        },
      ],
      timing: null,
    };
    const output = renderWatchDashboard(graph(), failed, {
      color: false,
    });

    expect(output).toContain("FAILED");
    expect(output).toContain("Failures");
    expect(output).toContain("✕ implement: validation failed");
    expect(output).toContain("→ inspect the logs: prism logs failed-run");
  });

  test("lists a needs-input blocker apart from failures, with PR and next action", () => {
    const blocked: RunInspection = {
      runId: "blocked-run",
      finished: false,
      nodes: [
        { nodeId: "context", state: "succeeded", timing: null, evidence: null },
        { nodeId: "implement", state: "failed", timing: null, evidence: null },
        { nodeId: "review", state: "blocked", timing: null, evidence: null },
      ],
      failures: [
        {
          nodeId: "implement",
          cause: {
            code: "WORKER_FAILURE_ADJUDICATED",
            error: "remains blocked: frozen contract lacks an ingress",
            state: { pullRequest: { url: "https://example.test/pr/6" } },
          },
          failureClass: "semantic_failed",
        },
      ],
      timing: null,
    };
    const output = renderWatchDashboard(graph(), blocked, {
      color: false,
      columns: 180,
    });
    expect(output).toContain("⏸ implement");
    expect(output).not.toContain("✕ implement");
    expect(output).toContain(
      "Needs your input · ⏸ implement: remains blocked: frozen contract lacks an ingress · https://example.test/pr/6",
    );
    expect(output).toContain(
      "→ resolve the blocker, then: prism rerun-node blocked-run implement",
    );
    expect(output).not.toContain("Failures ·");
  });

  test("collapses generated Beads plumbing into work-item dependency lanes", () => {
    const definition = buildBeadsGraph(
      [
        { id: "demo-1", title: "Lay the foundation", dependencies: [] },
        {
          id: "demo-2",
          title: "Ship the experience",
          dependencies: ["demo-1"],
        },
      ],
      { review: "none" },
    );
    const compiled = compileGraph(definition);
    if (!compiled.ok)
      throw new Error("Beads dashboard fixture did not compile");
    const states = new Map<string, RunInspection["nodes"][number]["state"]>([
      ["context-demo-1", "succeeded"],
      ["implement-demo-1", "succeeded"],
      ["merge-demo-1", "succeeded"],
      ["update-demo-1", "succeeded"],
      ["context-demo-2", "succeeded"],
      ["implement-demo-2", "running"],
    ]);
    const beadsInspection: RunInspection = {
      runId: "beads-dashboard",
      finished: false,
      nodes: compiled.graph.order.map((nodeId) => ({
        nodeId,
        state: states.get(nodeId) ?? "pending",
        timing: null,
        evidence: null,
      })),
      failures: [],
      timing: null,
    };

    const output = renderWatchDashboard(compiled.graph, beadsInspection, {
      columns: 80,
      rows: 24,
      color: false,
    });

    expect(output).toContain("DAG · 2 WORK ITEMS · 2 WAVES");
    expect(output).toContain("WAVE 01 · 1 PARALLEL ROOTS");
    expect(output).toContain("WAVE 02 · 1 WORK ITEM");
    expect(output).toContain("Lay the foundation");
    expect(output).toContain("← 1");
    expect(output).toContain("Ship the experience");
    expect(output).not.toContain("implement-demo-1");
    expect(output.split("\n")).toHaveLength(11);
    expect(output.split("\n").every((line) => line.length <= 80)).toBe(true);
  });

  test("shows the cross-work-item blocker for a queued workflow stage", () => {
    const definition = buildBeadsGraph(
      [
        { id: "demo-1", title: "Long-running foundation", dependencies: [] },
        { id: "demo-2", title: "Already reviewed work", dependencies: [] },
      ],
      { review: "none" },
    );
    const compiled = compileGraph(definition);
    if (!compiled.ok) throw new Error("Beads blocker fixture did not compile");
    const states = new Map<string, RunInspection["nodes"][number]["state"]>([
      ["context-demo-1", "succeeded"],
      ["implement-demo-1", "running"],
      ["merge-demo-1", "running"],
      ["context-demo-2", "succeeded"],
      ["implement-demo-2", "succeeded"],
      ["merge-demo-2", "resource_wait"],
    ]);
    const beadsInspection: RunInspection = {
      runId: "beads-runtime-wait",
      finished: false,
      nodes: compiled.graph.order.map((nodeId) => ({
        nodeId,
        state: states.get(nodeId) ?? "pending",
        timing: null,
        evidence: null,
      })),
      failures: [],
      timing: null,
    };

    const output = renderWatchDashboard(compiled.graph, beadsInspection, {
      columns: 100,
      rows: 24,
      color: false,
    });

    expect(output).toContain("MERGE WAIT ← 1 MERGE");
    expect(output).not.toContain("BUILD WAIT ←");
    expect(output.split("\n").every((line) => line.length <= 100)).toBe(true);
  });
});

describe("refresh revisions", () => {
  test("watch says which node's work item was refreshed, and when", () => {
    const output = renderWatchDashboard(
      graph(),
      {
        ...inspection(),
        graphRevisions: [
          {
            sequence: 0,
            graphRevision: 1,
            timestampMs: Date.UTC(2026, 9, 1, 8, 30),
            proposal: {
              id: "refresh:req",
              proposer: "operator:rerun-node --refresh",
              nodes: {},
              refresh: {
                targetNodeId: "implement",
                configs: {},
                source: { workItemId: "xondom-kko.9" },
              },
            },
            decision: { status: "accepted", policy: "operator-refresh" },
            addedNodeIds: [],
            refreshedNodeIds: ["context", "implement"],
          },
        ],
      },
      { columns: 120, color: false },
    );
    expect(output).toContain(
      "↻ refreshed work item for implement (xondom-kko.9) at 2026-10-01T08:30:00.000Z",
    );
  });
});

describe("poll mode dashboard", () => {
  // Imported lazily so the Beads-only tests above do not depend on poll exports.
  async function pollFixture(withItem: boolean) {
    const { buildPollGraph, buildPollProposal, parsePollConfig } =
      await import("@rsetia/prism/node");
    const config = parsePollConfig({
      name: "tickets",
      intervalSeconds: 300,
      source: { kind: "linear", label: "agent-implemented" },
    });
    const definition = buildPollGraph(config);
    const proposal = buildPollProposal(
      config,
      {
        key: "ENG-2142",
        title: "Add namespace-scoped routing",
        snapshot: { description: "Do it" },
      },
      "poll",
    );
    const parsed = parseGraph({
      ...definition,
      nodes: { ...definition.nodes, ...(withItem ? proposal.nodes : {}) },
    });
    if (!parsed.ok) throw new Error("poll fixture did not parse");
    const compiled = compileGraph(parsed.graph);
    if (!compiled.ok) throw new Error("poll fixture did not compile");
    const inspection: RunInspection = {
      runId: "poll-tickets",
      finished: false,
      nodes: compiled.graph.order.map((nodeId) => ({
        nodeId,
        state:
          nodeId === "poll" || nodeId.startsWith("implement-")
            ? ("running" as const)
            : ("succeeded" as const),
        timing: null,
        evidence: null,
      })),
      failures: [],
      graphRevisions: withItem
        ? [
            {
              sequence: 0,
              graphRevision: 1,
              timestampMs: 1_000,
              proposal,
              decision: { status: "accepted", policy: "poll" },
              addedNodeIds: Object.keys(proposal.nodes),
            },
          ]
        : [],
      timing: null,
    };
    return { graph: compiled.graph, inspection };
  }

  test("shows what is watched and where queued items stand", async () => {
    const { graph, inspection } = await pollFixture(true);
    const output = renderWatchDashboard(graph, inspection, {
      columns: 120,
      color: false,
      nowMs: 1_000 + 12 * 60_000,
    });
    expect(output).toContain("◆ POLL · linear");
    expect(output).toContain("▶ POLLING");
    expect(output).toContain(
      "WATCHING linear · label agent-implemented · every 5m",
    );
    expect(output).toContain(
      "1 queued · 1 active · 0 waiting · 0 ready for review · last queued ENG-2142 12m ago",
    );
    expect(output).toContain("Add namespace-scoped routing");
    expect(output).not.toContain("FINAL GATE");
  });

  test("says so while nothing has matched yet", async () => {
    const { graph, inspection } = await pollFixture(false);
    const output = renderWatchDashboard(graph, inspection, {
      columns: 100,
      color: false,
      nowMs: 0,
    });
    expect(output).toContain(
      "0 queued · 0 active · 0 waiting · 0 ready for review",
    );
    expect(output).toContain("NO WORK ITEMS YET");
    expect(output).not.toContain("EXECUTION DAG");
  });
});
