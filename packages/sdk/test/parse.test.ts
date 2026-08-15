import { describe, expect, test } from "vitest";
import { parseGraph } from "../src/index.js";

/** The plan's schema example — the canonical valid graph. */
const validGraph = {
  version: 1,
  nodes: {
    first: { executor: "constant", config: { value: "hello" } },
    second: {
      executor: "concat",
      dependsOn: ["first"],
      config: { separator: " " },
    },
  },
  finalNode: "second",
};

/** Parse an input expected to fail; returns its error codes. */
function failCodes(input: unknown): readonly string[] {
  const result = parseGraph(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors.map((e) => e.code);
}

/** Parse an input expected to fail; returns the full errors for field checks. */
function failErrors(input: unknown) {
  const result = parseGraph(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

describe("parseGraph", () => {
  test("accepts the canonical valid graph", () => {
    const result = parseGraph(validGraph);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.version).toBe(1);
    expect(result.graph.nodes["first"]?.dependsOn).toEqual([]);
    expect(result.graph.nodes["second"]?.dependsOn).toEqual(["first"]);
    expect(result.graph.finalNode).toBe("second");
  });

  test("rejects a non-object root with INVALID_ROOT", () => {
    for (const input of [null, undefined, 42, "graph", [validGraph]]) {
      expect(failCodes(input)).toContain("INVALID_ROOT");
    }
  });

  test("rejects versions other than literals 1 and 2 with UNSUPPORTED_VERSION", () => {
    expect(parseGraph({ ...validGraph, version: 2 }).ok).toBe(true);
    expect(failErrors({ ...validGraph, version: 3 })).toContainEqual({
      code: "UNSUPPORTED_VERSION",
      found: 3,
    });
    expect(failErrors({ ...validGraph, version: "1" })).toContainEqual({
      code: "UNSUPPORTED_VERSION",
      found: "1",
    });
    const withoutVersion: Record<string, unknown> = { ...validGraph };
    delete withoutVersion["version"];
    expect(failCodes(withoutVersion)).toContain("UNSUPPORTED_VERSION");
  });

  test("rejects unknown root properties with UNKNOWN_PROPERTY", () => {
    expect(failErrors({ ...validGraph, finalNodee: "second" })).toContainEqual({
      code: "UNKNOWN_PROPERTY",
      path: "finalNodee",
    });
  });

  test("rejects unknown node properties with UNKNOWN_PROPERTY", () => {
    const graph = {
      version: 1,
      nodes: { only: { executor: "constant", confg: {} } },
    };
    expect(failErrors(graph)).toContainEqual({
      code: "UNKNOWN_PROPERTY",
      path: "nodes.only.confg",
    });
  });

  test("rejects an empty nodes object with EMPTY_GRAPH", () => {
    expect(failCodes({ version: 1, nodes: {} })).toContain("EMPTY_GRAPH");
  });

  test("rejects empty-string node IDs with INVALID_NODE_ID", () => {
    const graph = { version: 1, nodes: { "": { executor: "noop" } } };
    expect(failErrors(graph)).toContainEqual({
      code: "INVALID_NODE_ID",
      nodeId: "",
    });
  });

  test("rejects a missing or non-string executor with INVALID_NODE", () => {
    for (const node of [{}, { executor: 42 }, { executor: "" }]) {
      expect(failErrors({ version: 1, nodes: { bad: node } })).toContainEqual({
        code: "INVALID_NODE",
        nodeId: "bad",
        property: "executor",
      });
    }
  });

  test("rejects a non-string-array dependsOn with INVALID_NODE", () => {
    for (const dependsOn of ["first", { first: true }, [1], ["first", 2]]) {
      const graph = {
        version: 1,
        nodes: {
          first: { executor: "constant" },
          bad: { executor: "concat", dependsOn },
        },
      };
      expect(failErrors(graph)).toContainEqual({
        code: "INVALID_NODE",
        nodeId: "bad",
        property: "dependsOn",
      });
    }
  });

  test("rejects duplicate dependsOn entries with DUPLICATE_DEPENDENCY", () => {
    const graph = {
      version: 1,
      nodes: {
        first: { executor: "constant" },
        second: { executor: "concat", dependsOn: ["first", "first"] },
      },
    };
    expect(failErrors(graph)).toContainEqual({
      code: "DUPLICATE_DEPENDENCY",
      nodeId: "second",
      dependencyId: "first",
    });
  });

  test("rejects a non-string or empty finalNode with INVALID_FINAL_NODE", () => {
    for (const finalNode of [5, "", ["second"]]) {
      expect(failCodes({ ...validGraph, finalNode })).toContain(
        "INVALID_FINAL_NODE",
      );
    }
  });

  test("passes config through untouched (opaque JSON)", () => {
    const config = { nested: { list: [1, "two", null, false], deep: {} } };
    const result = parseGraph({
      version: 1,
      nodes: { only: { executor: "constant", config } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.nodes["only"]?.config).toEqual(config);
  });

  test("parses only declarative version-2 evidence conditions", () => {
    const result = parseGraph({
      version: 2,
      nodes: {
        gate: {
          executor: "noop",
          when: {
            all: [
              { predicate: "changed_path", matches: "frontend/**" },
              { predicate: "diff_present", equals: true },
            ],
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.graph.nodes["gate"]?.when).toBeDefined();
    expect(
      failErrors({
        version: 2,
        nodes: {
          gate: {
            executor: "noop",
            when: { predicate: "command", equals: true },
          },
        },
      }),
    ).toContainEqual({
      code: "INVALID_CONDITION",
      nodeId: "gate",
      path: "when",
    });
    expect(
      failCodes({
        version: 1,
        nodes: {
          gate: {
            executor: "noop",
            when: { predicate: "diff_present", equals: true },
          },
        },
      }),
    ).toContain("CONDITION_REQUIRES_VERSION_2");
  });

  test("parses resource declarations and node requests", () => {
    const result = parseGraph({
      version: 1,
      resources: { database: { capacity: 2 } },
      nodes: {
        only: { executor: "constant", resources: ["database"] },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      graph: {
        resources: { database: { capacity: 2 } },
        nodes: { only: { resources: ["database"] } },
      },
    });
  });

  test("rejects malformed resources and duplicate node requests", () => {
    for (const resources of [
      null,
      [],
      { lock: {} },
      { lock: { capacity: 0 } },
      { lock: { capacity: 1.5 } },
    ]) {
      expect(
        failCodes({
          version: 1,
          resources,
          nodes: { only: { executor: "constant" } },
        }),
      ).toContain("INVALID_RESOURCES");
    }
    expect(
      failErrors({
        version: 1,
        resources: { lock: { capacity: 1 } },
        nodes: { only: { executor: "constant", resources: ["lock", "lock"] } },
      }),
    ).toContainEqual({
      code: "DUPLICATE_RESOURCE",
      nodeId: "only",
      resourceId: "lock",
    });
  });

  test("collects all errors in one pass, not just the first", () => {
    const codes = failCodes({
      version: 99,
      bogus: true,
      nodes: { a: { executor: "" } },
    });
    expect(codes).toContain("UNSUPPORTED_VERSION");
    expect(codes).toContain("UNKNOWN_PROPERTY");
    expect(codes).toContain("INVALID_NODE");
  });

  // Behavior beyond the checklist — pinned so it stays spec, not accident:

  test("rejects non-JSON config values (cycles, non-finite numbers)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const config of [cyclic, Number.NaN, Infinity, { fn: () => 1 }]) {
      expect(
        failErrors({ version: 1, nodes: { bad: { executor: "x", config } } }),
      ).toContainEqual({
        code: "INVALID_NODE",
        nodeId: "bad",
        property: "config",
      });
    }
  });

  test('handles a "__proto__" node ID without prototype pollution', () => {
    // Only JSON.parse can produce an own "__proto__" key — an object
    // literal would set the prototype instead.
    const input: unknown = JSON.parse(
      '{"version":1,"nodes":{"__proto__":{"executor":"noop"}},"finalNode":"__proto__"}',
    );
    const result = parseGraph(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.hasOwn(result.graph.nodes, "__proto__")).toBe(true);
    expect(result.graph.nodes["__proto__"]?.executor).toBe("noop");
    expect(({} as { executor?: unknown }).executor).toBeUndefined();
  });
});
