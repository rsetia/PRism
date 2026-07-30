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
      { nodeId: "context", state: "succeeded" },
      { nodeId: "implement", state: "running" },
      { nodeId: "review", state: "pending" },
    ],
    failures: [],
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
        { nodeId: "context", state: "succeeded" },
        { nodeId: "implement", state: "failed" },
        { nodeId: "review", state: "blocked" },
      ],
      failures: [
        {
          nodeId: "implement",
          cause: { message: "validation failed" },
          failureClass: "validation_failed",
        },
      ],
    };
    const output = renderWatchDashboard(graph(), failed, {
      color: false,
    });

    expect(output).toContain("FAILED");
    expect(output).toContain("Failures");
    expect(output).toContain('implement: {"message":"validation failed"}');
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
      })),
      failures: [],
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
      ["context-demo-2", "succeeded"],
      ["implement-demo-2", "succeeded"],
    ]);
    const beadsInspection: RunInspection = {
      runId: "beads-runtime-wait",
      finished: false,
      nodes: compiled.graph.order.map((nodeId) => ({
        nodeId,
        state: states.get(nodeId) ?? "pending",
      })),
      failures: [],
    };

    const output = renderWatchDashboard(compiled.graph, beadsInspection, {
      columns: 100,
      rows: 24,
      color: false,
    });

    expect(output).toContain("MERGE WAIT ← 1 CLOSE");
    expect(output).not.toContain("BUILD WAIT ←");
    expect(output.split("\n").every((line) => line.length <= 100)).toBe(true);
  });
});
