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
    const result = parseGraph(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain("INVALID_ROOT");
  });

  // The normative-rules checklist (plan §2) — implement one at a time:
  test.todo("rejects version !== literal 1 with UNSUPPORTED_VERSION");
  test.todo("rejects unknown root properties with UNKNOWN_PROPERTY");
  test.todo("rejects unknown node properties with UNKNOWN_PROPERTY");
  test.todo("rejects an empty nodes object with EMPTY_GRAPH");
  test.todo("rejects empty-string node IDs with INVALID_NODE_ID");
  test.todo("rejects a missing or non-string executor with INVALID_NODE");
  test.todo("rejects a non-string-array dependsOn with INVALID_NODE");
  test.todo("rejects duplicate dependsOn entries with DUPLICATE_DEPENDENCY");
  test.todo("rejects a non-string finalNode with INVALID_FINAL_NODE");
  test.todo("passes config through untouched (opaque JSON)");
  test.todo("collects all errors in one pass, not just the first");
});
