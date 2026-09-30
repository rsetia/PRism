import { describe, expect, test } from "vitest";
import {
  compileGraph,
  createManualClock,
  createMemoryStore,
  createEngine,
  createExecutorRegistry,
  inspectRun,
  parseGraph,
  submitGraphProposal,
} from "../src/index.js";
import type {
  GraphExpansionProposal,
  GraphProposalPolicy,
  RunStore,
} from "../src/index.js";

async function submitProposal(
  store: RunStore,
  runId: string,
  proposal: GraphExpansionProposal,
  policy: GraphProposalPolicy,
) {
  const lease = await store.acquireCoordinatorLease(runId, "test", 30_000);
  try {
    return await submitGraphProposal(store, runId, proposal, policy, lease);
  } finally {
    await store.releaseLease(lease);
  }
}

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
  test("rejects a revision from a coordinator that lost its lease", async () => {
    const clock = createManualClock();
    const store = createMemoryStore({ now: () => clock.now() });
    await store.createRun({ runId: "r", graph: graph() });
    const stale = await store.acquireCoordinatorLease("r", "stale", 10);
    clock.advance(10);
    const current = await store.acquireCoordinatorLease("r", "current", 10);

    await expect(
      submitGraphProposal(
        store,
        "r",
        {
          id: "stale-proposal",
          proposer: "start",
          nodes: {
            follow: {
              executor: "constant",
              dependsOn: ["start"],
            },
          },
        },
        () => ({ status: "accepted", policy: "test" }),
        stale,
      ),
    ).rejects.toThrow("fencing conflict");
    expect((await store.getRun("r"))?.graph.order).toEqual(["start"]);
    expect(await store.listGraphRevisions?.("r")).toEqual([]);
    await store.releaseLease(current);
  });

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
    const first = await submitProposal(store, "r", proposal, policy);
    const replay = await submitProposal(store, "r", proposal, policy);

    expect(first.status).toBe("accepted");
    expect(replay.revision.sequence).toBe(0);
    expect((await store.getRun("r"))?.graph.order).toEqual(["start", "follow"]);
    expect((await inspectRun(store, "r")).graphRevisions).toHaveLength(1);
  });

  test("records rejected and cyclic proposals without changing the graph", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "r", graph: graph() });
    const rejected = await submitProposal(
      store,
      "r",
      {
        id: "no",
        proposer: "operator",
        nodes: { later: { executor: "constant", dependsOn: [] } },
      },
      () => ({ status: "rejected", policy: "operator", reason: "not now" }),
    );
    const cycle = await submitProposal(
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
    const result = await submitProposal(
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

  test("dispatches accepted work while its proposer is still running", async () => {
    // A long-lived proposer (a poller) never settles on its own. The
    // scheduler must wake for the accepted expansion instead of waiting for
    // some unrelated node to finish.
    const store = createMemoryStore();
    let releaseProposer: () => void = () => undefined;
    const followFinished = new Promise<void>((resolve) => {
      releaseProposer = resolve;
    });
    const order: string[] = [];
    const registry = createExecutorRegistry([
      {
        name: "proposer",
        async execute(context) {
          const result = await context.submitGraphProposal?.({
            id: "while-running",
            proposer: context.nodeId,
            nodes: { follow: { executor: "follow", dependsOn: [] } },
          });
          order.push(`proposal ${result?.status ?? "missing"}`);
          await followFinished;
          order.push("proposer done");
          return { status: "succeeded", output: "polled" } as const;
        },
      },
      {
        name: "follow",
        execute() {
          order.push("follow");
          releaseProposer();
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

    const result = createEngine({
      store,
      registry,
      maxConcurrency: 2,
      graphProposalPolicy: () => ({ status: "accepted", policy: "test" }),
    }).run(compiled.graph, { runId: "live-expansion" }).result;
    const deadlock = new Promise<"deadlock">((resolve) => {
      setTimeout(resolve, 4_000, "deadlock");
    });

    const outcome = await Promise.race([result, deadlock]);
    expect(outcome).toEqual({ status: "succeeded", output: "polled" });
    expect(order).toEqual(["proposal accepted", "follow", "proposer done"]);
    const inspection = await inspectRun(store, "live-expansion");
    expect(
      Object.fromEntries(
        inspection.nodes.map((node) => [node.nodeId, node.state]),
      ),
    ).toEqual({ start: "succeeded", follow: "succeeded" });
  });

  test("replaying an accepted proposal keeps later expansions scheduled", async () => {
    // On resume a poller re-submits every item it already queued. Each replay
    // returns the historical revision; adopting that revision's graph would
    // strand everything accepted after it.
    const store = createMemoryStore();
    let releaseOne: () => void = () => undefined;
    const replayed = new Promise<void>((resolve) => {
      releaseOne = resolve;
    });
    let releaseProposer: () => void = () => undefined;
    const twoFinished = new Promise<void>((resolve) => {
      releaseProposer = resolve;
    });
    const registry = createExecutorRegistry([
      {
        name: "proposer",
        async execute(context) {
          const first = {
            id: "first",
            proposer: context.nodeId,
            nodes: { one: { executor: "one", dependsOn: [] } },
          };
          await context.submitGraphProposal?.(first);
          await context.submitGraphProposal?.({
            id: "second",
            proposer: context.nodeId,
            nodes: { two: { executor: "two", dependsOn: ["one"] } },
          });
          const replay = await context.submitGraphProposal?.(first);
          expect(replay?.status).toBe("accepted");
          releaseOne();
          await twoFinished;
          return { status: "succeeded", output: "polled" } as const;
        },
      },
      {
        name: "one",
        async execute() {
          await replayed;
          return { status: "succeeded", output: 1 } as const;
        },
      },
      {
        name: "two",
        execute() {
          releaseProposer();
          return { status: "succeeded", output: 2 } as const;
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

    const result = createEngine({
      store,
      registry,
      maxConcurrency: 3,
      graphProposalPolicy: () => ({ status: "accepted", policy: "test" }),
    }).run(compiled.graph, { runId: "replay" }).result;
    const deadlock = new Promise<"deadlock">((resolve) => {
      setTimeout(resolve, 4_000, "deadlock");
    });

    expect(await Promise.race([result, deadlock])).toEqual({
      status: "succeeded",
      output: "polled",
    });
    expect(await store.listGraphRevisions?.("replay")).toHaveLength(2);
  });

  test("durably rejects a proposal with invalid executor config", async () => {
    const store = createMemoryStore();
    let proposalStatus: string | undefined;
    const registry = createExecutorRegistry([
      {
        name: "proposer",
        async execute(context) {
          const result = await context.submitGraphProposal?.({
            id: "invalid-config",
            proposer: context.nodeId,
            nodes: {
              follow: { executor: "strict", dependsOn: [], config: {} },
            },
          });
          proposalStatus = result?.status;
          return { status: "succeeded", output: "done" };
        },
      },
      {
        name: "strict",
        validateConfig(config) {
          if (
            typeof config !== "object" ||
            config === null ||
            !("required" in config)
          ) {
            throw new Error("required config is missing");
          }
        },
        execute() {
          return { status: "succeeded", output: null };
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
    }).run(compiled.graph, { runId: "invalid-proposal" }).result;

    expect(outcome).toEqual({ status: "succeeded", output: "done" });
    expect(proposalStatus).toBe("rejected");
    expect((await store.getRun("invalid-proposal"))?.graph.order).toEqual([
      "start",
    ]);
    expect(
      (await store.listGraphRevisions?.("invalid-proposal"))?.[0]?.decision,
    ).toMatchObject({
      status: "rejected",
      policy: "executor-preflight",
    });
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
