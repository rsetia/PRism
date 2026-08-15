import { describe, expect, test } from "vitest";
import { compileGraph } from "../src/index.js";
import type {
  CompiledGraph,
  GraphDefinition,
  NodeDefinition,
} from "../src/index.js";

function definition(
  nodes: Readonly<Record<string, NodeDefinition>>,
  finalNode?: string,
): GraphDefinition {
  return finalNode === undefined
    ? { version: 1, nodes }
    : { version: 1, nodes, finalNode };
}

function expectCompiled(graph: GraphDefinition): CompiledGraph {
  const result = compileGraph(graph);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(
      `Expected compilation to succeed: ${JSON.stringify(result.errors)}`,
    );
  }
  return result.graph;
}

describe("compileGraph", () => {
  test("preserves graph version 2 in the compiled plan", () => {
    const graph = expectCompiled({
      version: 2,
      nodes: { only: { executor: "test", dependsOn: [] } },
      finalNode: "only",
    });
    expect(graph.version).toBe(2);
  });

  test("produces stable topological order with a lexicographic tie-break", () => {
    const graph = expectCompiled(
      definition(
        {
          d: { executor: "test", dependsOn: ["b", "c"] },
          c: { executor: "test", dependsOn: ["a"] },
          b: { executor: "test", dependsOn: ["a"] },
          a: { executor: "test", dependsOn: [] },
        },
        "d",
      ),
    );

    expect(graph.order).toEqual(["a", "b", "c", "d"]);
  });

  test("orders numeric-like node IDs lexicographically", () => {
    const graph = expectCompiled(
      definition(
        {
          "2": { executor: "test", dependsOn: [] },
          "10": { executor: "test", dependsOn: [] },
        },
        "2",
      ),
    );

    expect(graph.order).toEqual(["10", "2"]);
  });

  test("rejects self-dependencies with SELF_DEPENDENCY", () => {
    const result = compileGraph(
      definition({
        a: { executor: "test", dependsOn: ["a"] },
      }),
    );

    expect(result).toEqual({
      ok: false,
      errors: [{ code: "SELF_DEPENDENCY", nodeId: "a" }],
    });
  });

  test("rejects unknown dependencies with UNKNOWN_DEPENDENCY", () => {
    const result = compileGraph(
      definition({
        a: { executor: "test", dependsOn: ["missing"] },
      }),
    );

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "UNKNOWN_DEPENDENCY",
          nodeId: "a",
          dependencyId: "missing",
        },
      ],
    });
  });

  test("reports only nodes that participate in a cycle", () => {
    const result = compileGraph(
      definition({
        a: { executor: "test", dependsOn: ["b"] },
        b: { executor: "test", dependsOn: ["a"] },
        downstream: { executor: "test", dependsOn: ["a"] },
      }),
    );

    expect(result).toEqual({
      ok: false,
      errors: [{ code: "CYCLE", nodeIds: ["a", "b"] }],
    });
  });

  test("accepts a declared existing finalNode", () => {
    const graph = expectCompiled(
      definition(
        {
          first: { executor: "test", dependsOn: [] },
          second: { executor: "test", dependsOn: ["first"] },
        },
        "second",
      ),
    );

    expect(graph.finalNode).toBe("second");
  });

  test("infers finalNode from exactly one sink", () => {
    const graph = expectCompiled(
      definition({
        first: { executor: "test", dependsOn: [] },
        second: { executor: "test", dependsOn: ["first"] },
      }),
    );

    expect(graph.finalNode).toBe("second");
  });

  test("rejects an unknown finalNode", () => {
    const result = compileGraph(
      definition(
        {
          a: { executor: "test", dependsOn: [] },
        },
        "missing",
      ),
    );

    expect(result).toEqual({
      ok: false,
      errors: [{ code: "UNKNOWN_FINAL_NODE", finalNode: "missing" }],
    });
  });

  test("rejects multiple sinks without a declared finalNode", () => {
    const result = compileGraph(
      definition({
        b: { executor: "test", dependsOn: [] },
        a: { executor: "test", dependsOn: [] },
      }),
    );

    expect(result).toEqual({
      ok: false,
      errors: [{ code: "AMBIGUOUS_FINAL_NODE", sinkIds: ["a", "b"] }],
    });
  });

  test("precomputes dependents as the reverse of dependsOn", () => {
    const graph = expectCompiled(
      definition(
        {
          root: { executor: "test", dependsOn: [] },
          right: { executor: "test", dependsOn: ["root"] },
          left: { executor: "test", dependsOn: ["root"] },
          final: { executor: "test", dependsOn: ["left", "right"] },
        },
        "final",
      ),
    );

    expect(graph.nodes["root"]?.dependents).toEqual(["left", "right"]);
    expect(graph.nodes["left"]?.dependents).toEqual(["final"]);
    expect(graph.nodes["right"]?.dependents).toEqual(["final"]);
    expect(graph.nodes["final"]?.dependents).toEqual([]);
  });

  test("allows disconnected components when finalNode is declared", () => {
    const graph = expectCompiled(
      definition(
        {
          alpha: { executor: "test", dependsOn: [] },
          omega: { executor: "test", dependsOn: [] },
        },
        "omega",
      ),
    );

    expect(graph.order).toEqual(["alpha", "omega"]);
  });

  test("deep-freezes a defensive copy of the compiled graph", () => {
    const config = { nested: { values: ["one"] } };
    const source = definition(
      {
        a: { executor: "test", dependsOn: [], config },
      },
      "a",
    );
    const graph = expectCompiled(source);
    const compiledConfig = graph.nodes["a"]?.config;

    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(Object.isFrozen(graph.nodes["a"])).toBe(true);
    expect(Object.isFrozen(graph.order)).toBe(true);
    expect(Object.isFrozen(compiledConfig)).toBe(true);
    expect(compiledConfig).not.toBe(config);
    expect(Object.isFrozen(config)).toBe(false);
    expect(() => {
      (graph.order as string[]).push("other");
    }).toThrow(TypeError);
  });

  test("is deterministic for equal inputs", () => {
    const source = definition(
      {
        z: { executor: "test", dependsOn: ["a"] },
        a: { executor: "test", dependsOn: [] },
      },
      "z",
    );

    expect(compileGraph(source)).toEqual(compileGraph(source));
  });
});
