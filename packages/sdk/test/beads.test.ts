import { describe, expect, test } from "vitest";
import {
  buildBeadsGraph,
  compileGraph,
  parseBeadsJsonl,
  parseGraph,
} from "../src/index.js";
import type { Bead, GraphDefinition } from "../src/index.js";

const bead = (id: string, dependencies: string[] = []): Bead => ({
  id,
  title: `Work item ${id}`,
  dependencies,
});

/** Find the implement node the generator emitted for a given bead id. */
function implementNodeId(
  graph: GraphDefinition,
  beadId: string,
): string | undefined {
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node.executor !== "implement") continue;
    const config = node.config as { workItem?: { id?: string } } | undefined;
    if (config?.workItem?.id === beadId) return nodeId;
  }
  return undefined;
}

function executorNames(graph: GraphDefinition): string[] {
  return Object.values(graph.nodes).map((node) => node.executor);
}

describe("parseBeadsJsonl", () => {
  test("parses newline-delimited beads, skipping blank lines", () => {
    const text = `{"id":"A","title":"first"}\n\n{"id":"B","dependencies":["A"]}\n`;
    const beads = parseBeadsJsonl(text);
    expect(beads.map((b) => b.id)).toEqual(["A", "B"]);
    expect(beads[1]?.dependencies).toEqual(["A"]);
  });

  test("rejects a malformed line, naming its number", () => {
    const text = `{"id":"A"}\nnot json\n`;
    expect(() => parseBeadsJsonl(text)).toThrow(/2/);
  });

  test("rejects a bead without a string id", () => {
    expect(() => parseBeadsJsonl(`{"title":"no id"}`)).toThrow();
  });

  test("normalizes rich dependency objects and ignores entries without ids", () => {
    const beads = parseBeadsJsonl(
      `{"id":"B","dependencies":[{"id":"A"},{"title":"missing"},"C","C"]}`,
    );
    expect(beads[0]?.dependencies).toEqual(["A", "C"]);
  });
});

describe("buildBeadsGraph", () => {
  test("emits one implement node per bead", () => {
    const graph = buildBeadsGraph([bead("A"), bead("B")]);
    expect(implementNodeId(graph, "A")).toBeDefined();
    expect(implementNodeId(graph, "B")).toBeDefined();
    expect(executorNames(graph).filter((n) => n === "implement")).toHaveLength(
      2,
    );
  });

  test("the generated graph compiles", () => {
    const graph = buildBeadsGraph([bead("A"), bead("B", ["A"])]);
    const compiled = compileGraph(graph);
    expect(compiled.ok).toBe(true);
  });

  test("the generated graph is valid untrusted input for parseGraph", () => {
    const graph = buildBeadsGraph([bead("A")]);
    const roundTripped: unknown = JSON.parse(JSON.stringify(graph));
    expect(parseGraph(roundTripped).ok).toBe(true);
  });

  test("a dependency orders the dependent after it", () => {
    const graph = buildBeadsGraph([bead("B", ["A"]), bead("A")]);
    const compiled = compileGraph(graph);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const order = compiled.graph.order;
    const implA = implementNodeId(graph, "A");
    const implB = implementNodeId(graph, "B");
    expect(order.indexOf(implA ?? "")).toBeLessThan(order.indexOf(implB ?? ""));
  });

  test("implement config carries the work item and review gate", () => {
    const graph = buildBeadsGraph([bead("MC-1")], { review: "greptile" });
    const nodeId = implementNodeId(graph, "MC-1");
    expect(nodeId).toBeDefined();
    const config = graph.nodes[nodeId ?? ""]?.config as {
      workItem?: { id?: string; provider?: string };
      review?: { by?: string };
    };
    expect(config.workItem?.id).toBe("MC-1");
    expect(config.workItem?.provider).toBe("beads");
    expect(config.review?.by).toBe("greptile");
  });

  test("includeBeadsUpdate: false omits beads_update nodes", () => {
    const withUpdate = buildBeadsGraph([bead("A")]);
    expect(executorNames(withUpdate)).toContain("beads_update");
    const without = buildBeadsGraph([bead("A")], {
      includeBeadsUpdate: false,
    });
    expect(executorNames(without)).not.toContain("beads_update");
  });

  test("can omit merge nodes while retaining beads updates", () => {
    const graph = buildBeadsGraph([bead("A")], { includeMerge: false });
    const implementId = implementNodeId(graph, "A");
    expect(executorNames(graph)).not.toContain("merge_resolve");
    const update = Object.values(graph.nodes).find(
      (node) => node.executor === "beads_update",
    );
    expect(update?.dependsOn).toEqual([implementId]);
    expect(graph.finalNode).toBeDefined();
  });

  test("adds a stable aggregator for multiple bead terminals", () => {
    const graph = buildBeadsGraph([bead("B"), bead("A")], {
      includeMerge: false,
      includeBeadsUpdate: false,
    });
    expect(graph.finalNode).toBe("beads-final");
    expect(graph.nodes["beads-final"]).toMatchObject({
      executor: "join_newline",
      kind: "merge",
    });
  });

  test("rejects an empty bead set", () => {
    expect(() => buildBeadsGraph([])).toThrow();
  });

  test("rejects a dangling dependency", () => {
    expect(() => buildBeadsGraph([bead("A", ["ghost"])])).toThrow();
  });

  test("rejects dependency cycles", () => {
    expect(() => buildBeadsGraph([bead("A", ["B"]), bead("B", ["A"])])).toThrow(
      /cycle/i,
    );
  });

  test("rejects ids that collide after slugging", () => {
    expect(() => buildBeadsGraph([bead("A B"), bead("a-b")])).toThrow(
      /collide/i,
    );
  });
});
