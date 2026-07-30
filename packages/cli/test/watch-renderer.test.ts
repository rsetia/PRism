import {
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

    expect(output).toContain("Prism · run-dashboard · RUNNING");
    expect(output).toContain("1/3 settled · 1 running");
    expect(output).toContain("Active: ▶ implement");
    expect(output).toContain("Wave 0 · roots");
    expect(output).toContain("Wave 1");
    expect(output).toContain("Wave 2");
    expect(output).toContain("✓ context");
    expect(output).toContain("▶ implement ← context");
    expect(output).toContain("○ review ← implement");
    expect(output).not.toContain("\u001B[");
  });

  test("uses a high-contrast highlight for running nodes", () => {
    const output = renderWatchDashboard(graph(), inspection(), {
      columns: 90,
      color: true,
    });

    expect(output).toContain("\u001B[1;30;46m");
    expect(output).toContain("▶ implement");
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
});
