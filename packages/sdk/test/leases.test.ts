import { describe, expect, test } from "vitest";
import { createManualClock } from "../src/adapters/clock.js";
import { createMemoryStore } from "../src/adapters/memory-store.js";
import { compileGraph } from "../src/graph/compile.js";
import { parseGraph } from "../src/graph/parse.js";

function graph() {
  const parsed = parseGraph({
    version: 1,
    finalNode: "only",
    nodes: { only: { executor: "constant" } },
  });
  if (!parsed.ok) throw new Error("fixture graph did not parse");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture graph did not compile");
  return compiled.graph;
}

describe("run leases", () => {
  test("expired owners are replaced and fenced from later writes", async () => {
    const clock = createManualClock();
    const store = createMemoryStore({ now: () => clock.now() });
    await store.createRun({ runId: "r", graph: graph() });
    const first = await store.acquireCoordinatorLease("r", "first", 10);
    await expect(
      store.acquireCoordinatorLease("r", "second", 10),
    ).rejects.toThrow("ownership conflict");
    clock.advance(10);
    const second = await store.acquireCoordinatorLease("r", "second", 10);
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    await expect(
      store.appendEvents(
        "r",
        [{ kind: "node_ready", nodeId: "only" }],
        0,
        first,
      ),
    ).rejects.toThrow("fencing conflict");
    await expect(
      store.appendEvents(
        "r",
        [{ kind: "node_ready", nodeId: "only" }],
        0,
        second,
      ),
    ).resolves.toHaveLength(1);
  });

  test("renewal preserves the token and status hides the owner", async () => {
    const clock = createManualClock();
    const store = createMemoryStore({ now: () => clock.now() });
    await store.createRun({ runId: "r", graph: graph() });
    const lease = await store.acquireNodeLease(
      "r",
      "only",
      "secret-host-name",
      10,
    );
    clock.advance(5);
    const renewed = await store.renewLease(lease, 10);
    expect(renewed.fencingToken).toBe(lease.fencingToken);
    expect(await store.getRunLeases("r")).toEqual([
      {
        kind: "node",
        nodeId: "only",
        fencingToken: lease.fencingToken,
        expiresAtMs: 15,
      },
    ]);
  });
});
