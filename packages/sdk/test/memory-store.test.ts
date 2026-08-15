import { expect, test } from "vitest";
import { createMemoryStore } from "../src/index.js";
import { compileGraph, parseGraph } from "../src/index.js";
import { runStoreContract } from "../src/testing/index.js";

// The memory store is now defined by the shared contract (plan §12) —
// the same suite the SQLite store must pass. Memory-only behaviors, if
// any arise, would be added here alongside this call.
runStoreContract("createMemoryStore", () =>
  Promise.resolve(createMemoryStore()),
);

test("createMemoryStore accepts a deterministic timestamp source", async () => {
  const parsed = parseGraph({
    version: 1,
    nodes: { only: { executor: "constant", config: { value: 1 } } },
    finalNode: "only",
  });
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  const store = createMemoryStore({ now: () => 456 });
  await store.createRun({ runId: "r", graph: compiled.graph });

  const events = await store.appendEvents("r", [
    { kind: "node_ready", nodeId: "only" },
  ]);

  expect(events[0]?.timestampMs).toBe(456);
});
