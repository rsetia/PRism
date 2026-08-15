import { describe, expect, test } from "vitest";
import {
  compileGraph,
  createMemoryStore,
  createEngine,
  createExecutorRegistry,
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
      {
        id: "no",
        proposer: "operator",
        nodes: { later: { executor: "constant", dependsOn: [] } },
      },
      () => ({ status: "rejected", policy: "operator", reason: "not now" }),
    );
    const cycle = await submitGraphProposal(
      store,
      "r",
      {
        id: "cycle",
        proposer: "operator",
        nodes: { loop: { executor: "constant", dependsOn: ["loop"] } },
      },
      () => ({ status: "accepted", policy: "automatic" }),
    );

    expect(rejected.status).toBe("rejected");
    expect(cycle.status).toBe("rejected");
    expect((await store.getRun("r"))?.graph.order).toEqual(["start"]);
    expect(
      (await store.listGraphRevisions?.("r"))?.map(
        (entry) => entry.decision.status,
      ),
    ).toEqual(["rejected", "rejected"]);
  });

  test("rejects attempts to replace an existing node definition", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "r", graph: graph() });
    const result = await submitGraphProposal(
      store,
      "r",
      {
        id: "replace",
        proposer: "operator",
        nodes: { start: { executor: "other", dependsOn: [] } },
      },
      () => ({ status: "accepted", policy: "automatic" }),
    );
    expect(result.status).toBe("rejected");
    expect((await store.getRun("r"))?.graph.nodes["start"]?.executor).toBe(
      "constant",
    );
  });

  test("an executor proposal is dispatched by the live scheduler", async () => {
    const store = createMemoryStore();
    const seen: string[] = [];
    const registry = createExecutorRegistry([
      {
        name: "proposer",
        async execute(context) {
          await context.submitGraphProposal?.({
            id: "during-run",
            proposer: context.nodeId,
            nodes: {
              follow: { executor: "follow", dependsOn: [context.nodeId] },
            },
            finalNode: "follow",
          });
          return { status: "succeeded", output: "start" };
        },
      },
      {
        name: "follow",
        execute() {
          seen.push("follow");
          return { status: "succeeded", output: "done" };
        },
      },
    ]);
    const parsed = parseGraph({
      version: 1,
      nodes: { start: { executor: "proposer" } },
      finalNode: "start",
    });
    if (!parsed.ok) throw new Error("fixture parse failed");
    const compiled = compileGraph(parsed.graph);
    if (!compiled.ok) throw new Error("fixture compile failed");

    const outcome = await createEngine({
      store,
      registry,
      graphProposalPolicy: () => ({ status: "accepted", policy: "test" }),
    }).run(compiled.graph).result;
    expect(outcome).toEqual({ status: "succeeded", output: "done" });
    expect(seen).toEqual(["follow"]);
  });

  test("dispatches independent accepted work when its proposer fails", async () => {
    const store = createMemoryStore();
    const seen: string[] = [];
    const registry = createExecutorRegistry([
      {
        name: "proposer",
        async execute(context) {
          await context.submitGraphProposal?.({
            id: "independent-during-failure",
            proposer: context.nodeId,
            nodes: { follow: { executor: "follow", dependsOn: [] } },
            finalNode: "follow",
          });
          return { status: "failed", cause: "expected" } as const;
        },
      },
      {
        name: "follow",
        execute() {
          seen.push("follow");
          return { status: "succeeded", output: "done" } as const;
        },
      },
    ]);
    const parsed = parseGraph({
      version: 1,
      nodes: { start: { executor: "proposer" } },
      finalNode: "start",
    });
    if (!parsed.ok) throw new Error("fixture parse failed");
    const compiled = compileGraph(parsed.graph);
    if (!compiled.ok) throw new Error("fixture compile failed");

    const outcome = await createEngine({
      store,
      registry,
      graphProposalPolicy: () => ({ status: "accepted", policy: "test" }),
    }).run(compiled.graph).result;
    expect(outcome).toMatchObject({ status: "failed" });
    expect(seen).toEqual(["follow"]);
  });
});
