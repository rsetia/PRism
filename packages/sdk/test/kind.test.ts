import { describe, expect, test } from "vitest";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  parseGraph,
} from "../src/index.js";
import type { ExecutorDefinition } from "../src/index.js";

function parsed(definition: unknown) {
  const result = parseGraph(definition);
  return result;
}

describe("node kind — parse", () => {
  test("extracts an explicit kind", () => {
    const result = parsed({
      version: 1,
      nodes: {
        a: { executor: "constant", config: { value: 1 } },
        b: { executor: "join", kind: "merge", dependsOn: ["a"] },
      },
      finalNode: "b",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.nodes["b"]?.kind).toBe("merge");
  });

  test("rejects an unknown kind with INVALID_KIND", () => {
    const result = parsed({
      version: 1,
      nodes: { a: { executor: "constant", kind: "sideways", config: {} } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      code: "INVALID_KIND",
      nodeId: "a",
      found: "sideways",
    });
  });

  test("a node without kind parses (compile supplies the default)", () => {
    const result = parsed({
      version: 1,
      nodes: { a: { executor: "constant", config: { value: 1 } } },
    });
    expect(result.ok).toBe(true);
  });
});

describe("node kind — compile", () => {
  test("resolves an omitted kind to task", () => {
    const parsedResult = parseGraph({
      version: 1,
      nodes: { a: { executor: "constant", config: { value: 1 } } },
      finalNode: "a",
    });
    if (!parsedResult.ok) throw new Error("parse failed");
    const compiled = compileGraph(parsedResult.graph);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.graph.nodes["a"]?.kind).toBe("task");
  });

  test("carries an explicit kind through to the compiled node", () => {
    const parsedResult = parseGraph({
      version: 1,
      nodes: {
        a: { executor: "constant", config: { value: 1 } },
        b: { executor: "join", kind: "merge", dependsOn: ["a"] },
      },
      finalNode: "b",
    });
    if (!parsedResult.ok) throw new Error("parse failed");
    const compiled = compileGraph(parsedResult.graph);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.graph.nodes["b"]?.kind).toBe("merge");
    expect(compiled.graph.nodes["a"]?.kind).toBe("task");
  });
});

describe("node kind — executor input shaping", () => {
  test("the executor receives kind plus raw inputs in dependency order", async () => {
    const shapeAware: ExecutorDefinition = {
      name: "shape-aware",
      execute(context) {
        return {
          status: "succeeded",
          output: {
            kind: context.kind,
            inputs: [...context.inputs],
          },
        };
      },
    };
    const parsedResult = parseGraph({
      version: 1,
      nodes: {
        left: { executor: "constant", config: { value: "L" } },
        right: { executor: "constant", config: { value: "R" } },
        merged: {
          executor: "shape-aware",
          kind: "merge",
          dependsOn: ["right", "left"],
        },
      },
      finalNode: "merged",
    });
    if (!parsedResult.ok) throw new Error("parse failed");
    const compiled = compileGraph(parsedResult.graph);
    if (!compiled.ok) throw new Error("compile failed");

    const outcome = await createEngine({
      store: createMemoryStore(),
      registry: createExecutorRegistry([...builtinExecutors, shapeAware]),
    }).run(compiled.graph).result;
    expect(outcome).toEqual({
      status: "succeeded",
      output: { kind: "merge", inputs: ["R", "L"] },
    });
  });
});
