import { describe, expect, test } from "vitest";
import {
  compileGraph,
  createMemoryStore,
  inspectRun,
  parseGraph,
  submitGraphProposal,
} from "../src/index.js";

function graph() {
  const parsed = parseGraph({
    version: 1,
    nodes: { start: { executor: "constant" } },
    finalNode: "start",
  });
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

describe("audited graph expansion", () => {
  test("accepts an append exactly once and exposes its revision to inspect", async () => {
    const store = createMemoryStore({ now: () => 42 });
    await store.createRun({ runId: "r", graph: graph() });
    const proposal = {
      id: "follow-up",
      proposer: "start",
      nodes: { follow: { executor: "constant", dependsOn: ["start"] } },
      finalNode: "follow",
    } as const;
    const policy = () => ({ status: "accepted" as const, policy: "test" });
    const first = await submitGraphProposal(store, "r", proposal, policy);
    const replay = await submitGraphProposal(store, "r", proposal, policy);

    expect(first.status).toBe("accepted");
    expect(replay.revision.sequence).toBe(0);
    expect((await store.getRun("r"))?.graph.order).toEqual(["start", "follow"]);
    expect((await inspectRun(store, "r")).graphRevisions).toHaveLength(1);
  });

  test("records rejected and cyclic proposals without changing the graph", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "r", graph: graph() });
    const rejected = await submitGraphProposal(
      store,
      "r",
      { id: "no", proposer: "operator", nodes: { later: { executor: "constant", dependsOn: [] } } },
      () => ({ status: "rejected", policy: "operator", reason: "not now" }),
    );
    const cycle = await submitGraphProposal(
      store,
      "r",
      { id: "cycle", proposer: "operator", nodes: { loop: { executor: "constant", dependsOn: ["loop"] } } },
      () => ({ status: "accepted", policy: "automatic" }),
    );

    expect(rejected.status).toBe("rejected");
    expect(cycle.status).toBe("rejected");
    expect((await store.getRun("r"))?.graph.order).toEqual(["start"]);
    expect((await store.listGraphRevisions?.("r"))?.map((entry) => entry.decision.status)).toEqual(["rejected", "rejected"]);
  });
});
