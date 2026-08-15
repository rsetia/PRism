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

test("leases fence stale writers after expiry and takeover", async () => {
  let time = 100;
  const store = createMemoryStore({ now: () => time });
  const parsed = parseGraph({
    version: 1,
    nodes: { only: { executor: "constant" } },
    finalNode: "only",
  });
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  await store.createRun({ runId: "r", graph: compiled.graph });
  const first = await store.acquireLease?.({
    runId: "r",
    owner: "first",
    ttlMs: 10,
  });
  if (first === undefined) throw new Error("memory store has no leases");
  time = 110;
  const second = await store.acquireLease?.({
    runId: "r",
    owner: "second",
    ttlMs: 10,
  });
  if (second === undefined) throw new Error("memory store has no leases");
  expect(second.fencingToken).toBe(first.fencingToken + 1);
  await expect(
    Promise.resolve().then(() =>
      store.appendEvents(
        "r",
        [{ kind: "node_ready", nodeId: "only" }],
        0,
        first,
      ),
    ),
  ).rejects.toThrow(/fencing/);
  await expect(
    store.appendEvents(
      "r",
      [{ kind: "node_ready", nodeId: "only" }],
      0,
      second,
    ),
  ).resolves.toHaveLength(1);
});
