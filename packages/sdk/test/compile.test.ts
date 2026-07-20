import { describe, test } from "vitest";

// Section 2, steps 3-4 — write these after parseGraph is green.
// (Import compileGraph from "../src/index.js" when the first one goes live.)
describe("compileGraph", () => {
  test.todo(
    "produces stable topological order (Kahn, lexicographic tie-break)",
  );
  test.todo(
    "orders numeric-like node IDs deterministically (JS key-reorder trap)",
  );
  test.todo("rejects self-dependencies with SELF_DEPENDENCY");
  test.todo("rejects unknown dependencies with UNKNOWN_DEPENDENCY");
  test.todo("detects cycles with CYCLE, reporting the nodes involved");
  test.todo("accepts a declared, existing finalNode");
  test.todo("infers finalNode from exactly one sink when omitted");
  test.todo("rejects an unknown finalNode with UNKNOWN_FINAL_NODE");
  test.todo(
    "rejects multiple sinks without a declared finalNode as AMBIGUOUS_FINAL_NODE",
  );
  test.todo("precomputes dependents as exact reverse of dependsOn");
  test.todo("allows disconnected components (plan: execute everything)");
  test.todo("deep-freezes the compiled graph — mutation attempts throw");
  test.todo("is deterministic: equal inputs compile to identical output");
});
