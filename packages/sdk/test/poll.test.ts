import { describe, expect, test } from "vitest";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createManualClock,
  createMemoryStore,
  inspectRun,
  parseGraph,
} from "../src/index.js";
import type { ExecutorDefinition, JsonValue } from "../src/index.js";
import {
  buildPollGraph,
  buildPollProposal,
  createPollExecutor,
  parsePollConfig,
  POLL_IMPLEMENT_RESOURCE,
  pollGraphProposalPolicy,
  pollRunId,
} from "../src/node/index.js";
import type { PollItem, PollSource } from "../src/node/index.js";

const baseConfig = {
  name: "tickets",
  source: { kind: "fake" },
} as const;

function item(key: string, extra: Partial<PollItem> = {}): PollItem {
  return {
    key,
    title: `Title ${key}`,
    url: `https://example.test/${key}`,
    snapshot: { description: `Do ${key}` },
    ...extra,
  };
}

function compile(config: unknown) {
  const parsed = parseGraph(buildPollGraph(parsePollConfig(config)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.graph;
}

async function waitFor(condition: () => boolean | Promise<boolean>) {
  // Time-based, not turn-based, so a loaded CI machine gets the same budget.
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition never became true");
}

describe("parsePollConfig", () => {
  test("applies defaults, including the strict 5/5 review gate", () => {
    const config = parsePollConfig(baseConfig);
    expect(config).toMatchObject({
      version: 1,
      name: "tickets",
      intervalSeconds: 300,
      maxParallel: 3,
      implement: {
        targetBranch: "main",
        branchPrefix: "prism/",
        useSourceBranchName: true,
        review: {
          by: "greptile",
          minConfidenceScore: 5,
          requireNoActionableFindings: true,
          requireGreenChecks: true,
        },
      },
    });
    expect(pollRunId(config)).toBe("poll-tickets");
  });

  test.each([
    [{ ...baseConfig, extra: true }, 'unknown key "extra"'],
    [{ ...baseConfig, name: "Has Spaces" }, "name must be"],
    [{ ...baseConfig, intervalSeconds: 5 }, "at least 30"],
    [{ ...baseConfig, maxParallel: 0 }, "positive integer"],
    [{ ...baseConfig, source: {} }, "source.kind"],
    [{ ...baseConfig, implement: { reviwe: {} } }, 'unknown key "reviwe"'],
    [{ ...baseConfig, implement: { review: { by: "bogus" } } }, "review.by"],
  ])("rejects %j", (config, message) => {
    expect(() => parsePollConfig(config)).toThrow(message);
  });
});

describe("buildPollProposal", () => {
  test("freezes the snapshot into a context node ahead of a gated implementer", () => {
    const config = parsePollConfig({
      ...baseConfig,
      implement: { validationCommands: ["npm test"], maxIterations: 4 },
    });
    const proposal = buildPollProposal(
      config,
      item("ENG-2142", { branchName: "rav/eng-2142-routing" }),
      "poll",
    );
    expect(proposal.id).toBe("poll:fake:ENG-2142");
    expect(proposal.proposer).toBe("poll:poll");
    expect(proposal.nodes).toEqual({
      "context-fake-eng-2142": {
        executor: "constant",
        kind: "task",
        dependsOn: [],
        config: {
          value: {
            description: "Do ENG-2142",
            provider: "fake",
            id: "ENG-2142",
          },
        },
      },
      "implement-fake-eng-2142": {
        executor: "implement",
        kind: "task",
        dependsOn: ["context-fake-eng-2142"],
        resources: [POLL_IMPLEMENT_RESOURCE],
        config: {
          workItem: {
            provider: "fake",
            id: "ENG-2142",
            title: "Title ENG-2142",
            url: "https://example.test/ENG-2142",
          },
          targetBranch: "main",
          branchName: "rav/eng-2142-routing",
          review: config.implement.review,
          maxIterations: 4,
          validationCommands: ["npm test"],
        },
      },
    });
  });

  test("falls back to the prefix branch when the source has none or it is disabled", () => {
    const withoutSourceBranch = buildPollProposal(
      parsePollConfig(baseConfig),
      item("ENG-1"),
      "poll",
    );
    const disabled = buildPollProposal(
      parsePollConfig({
        ...baseConfig,
        implement: { useSourceBranchName: false, branchPrefix: "agent/" },
      }),
      item("ENG-1", { branchName: "rav/eng-1" }),
      "poll",
    );
    const branch = (proposal: typeof disabled) =>
      (proposal.nodes["implement-fake-eng-1"]?.config as { branchName: string })
        .branchName;
    expect(branch(withoutSourceBranch)).toBe("prism/eng-1");
    expect(branch(disabled)).toBe("agent/eng-1");
  });
});

describe("pollGraphProposalPolicy", () => {
  const context = { runId: "r", graphRevision: 0 };
  test("accepts poll proposals of context and implement nodes only", async () => {
    const proposal = buildPollProposal(
      parsePollConfig(baseConfig),
      item("A-1"),
      "poll",
    );
    expect(await pollGraphProposalPolicy(proposal, context)).toEqual({
      status: "accepted",
      policy: "poll",
    });
    expect(
      await pollGraphProposalPolicy(
        { ...proposal, proposer: "planner" },
        context,
      ),
    ).toMatchObject({ status: "rejected" });
    expect(
      await pollGraphProposalPolicy(
        {
          ...proposal,
          nodes: { merge: { executor: "merge_resolve", dependsOn: [] } },
        },
        context,
      ),
    ).toMatchObject({ status: "rejected" });
    const rejected = await pollGraphProposalPolicy(
      {
        ...proposal,
        nodes: { merge: { executor: "merge_resolve", dependsOn: [] } },
      },
      context,
    );
    expect(rejected.status === "rejected" ? rejected.reason : "").toContain(
      "merge_resolve",
    );
  });
});

describe("poll runs", () => {
  function harness(maxParallel = 2) {
    const clock = createManualClock();
    const store = createMemoryStore();
    let listed: PollItem[] = [];
    let listCalls = 0;
    const loads: string[] = [];
    const logs: string[] = [];
    const implemented: {
      nodeId: string;
      input: JsonValue;
      config: JsonValue;
    }[] = [];
    const gates = new Map<string, () => void>();
    const source: PollSource = {
      kind: "fake",
      validateConfig() {},
      list() {
        listCalls += 1;
        return Promise.resolve({
          candidates: listed.map(({ key, title }) => ({ key, title })),
          skipped: [{ key: "SKIP-1", reason: "not applied by you" }],
        });
      },
      load(_config, candidate) {
        loads.push(candidate.key);
        const found = listed.find((entry) => entry.key === candidate.key);
        if (found === undefined) return Promise.reject(new Error("gone"));
        return Promise.resolve(found);
      },
    };
    const implement: ExecutorDefinition = {
      name: "implement",
      execute(context) {
        implemented.push({
          nodeId: context.nodeId,
          input: context.inputs[0] ?? null,
          config: context.config ?? null,
        });
        return new Promise((resolve) => {
          gates.set(context.nodeId, () => {
            resolve({ status: "succeeded", output: context.nodeId });
          });
          context.signal.addEventListener("abort", () => {
            resolve({ status: "failed", cause: "cancelled" });
          });
        });
      },
    };
    const registry = createExecutorRegistry([
      ...builtinExecutors,
      implement,
      createPollExecutor({
        sources: [source],
        clock,
        log: (line) => logs.push(line),
      }),
    ]);
    const engine = createEngine({
      store,
      registry,
      maxConcurrency: maxParallel + 2,
      graphProposalPolicy: pollGraphProposalPolicy,
    });
    const graph = compile({ ...baseConfig, maxParallel, intervalSeconds: 60 });
    return {
      clock,
      store,
      logs,
      loads,
      implemented,
      gates,
      listCalls: () => listCalls,
      setListed(items: PollItem[]) {
        listed = items;
      },
      start: () => engine.run(graph, { runId: "poll-tickets" }),
    };
  }

  test("queues each newly matching item once and keeps polling", async () => {
    const h = harness();
    h.setListed([item("A-1")]);
    const handle = h.start();

    await waitFor(() => h.implemented.length === 1);
    expect(h.implemented[0]).toMatchObject({
      nodeId: "implement-fake-a-1",
      input: { description: "Do A-1", provider: "fake", id: "A-1" },
    });

    h.setListed([item("A-1"), item("B-2")]);
    h.clock.advance(60_000);
    await waitFor(() => h.implemented.length === 2);
    h.clock.advance(60_000);
    await waitFor(() => h.listCalls() === 3);

    // A-1 is never re-loaded or re-queued; the skip is logged once.
    expect(h.loads).toEqual(["A-1", "B-2"]);
    expect(h.logs.filter((line) => line.includes("SKIP-1"))).toHaveLength(1);
    expect(h.logs).toContain("poll tickets: queued B-2: Title B-2");

    h.gates.get("implement-fake-a-1")?.();
    await waitFor(async () =>
      (await inspectRun(h.store, "poll-tickets")).nodes.some(
        (node) =>
          node.nodeId === "implement-fake-a-1" && node.state === "succeeded",
      ),
    );
    await handle.cancel("operator stop");
    const outcome = await handle.result;
    expect(outcome.status).toBe("cancelled");
    const inspection = await inspectRun(h.store, "poll-tickets");
    expect(
      Object.fromEntries(
        inspection.nodes.map((node) => [node.nodeId, node.state]),
      ),
    ).toEqual({
      poll: "cancelled",
      "context-fake-a-1": "succeeded",
      "implement-fake-a-1": "succeeded",
      "context-fake-b-2": "succeeded",
      "implement-fake-b-2": "cancelled",
    });
    expect(
      inspection.graphRevisions?.map((revision) => revision.proposal.id),
    ).toEqual(["poll:fake:A-1", "poll:fake:B-2"]);
  });

  test("caps concurrent implementers with the poll semaphore", async () => {
    const h = harness(1);
    h.setListed([item("A-1"), item("B-2")]);
    const handle = h.start();

    await waitFor(() => h.implemented.length === 1);
    await waitFor(async () =>
      (await inspectRun(h.store, "poll-tickets")).nodes.some(
        (node) =>
          node.nodeId === "implement-fake-b-2" &&
          node.state === "resource_wait",
      ),
    );
    h.gates.get(h.implemented[0]?.nodeId ?? "")?.();
    await waitFor(() => h.implemented.length === 2);
    await handle.cancel();
    await handle.result;
  });

  test("keeps polling after a source failure", async () => {
    const h = harness();
    let fail = true;
    h.setListed([item("A-1")]);
    const flaky: PollSource = {
      kind: "fake",
      validateConfig() {},
      list() {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("HTTP 502"));
        }
        return Promise.resolve({
          candidates: [{ key: "A-1", title: "Title A-1" }],
          skipped: [],
        });
      },
      load() {
        return Promise.resolve(item("A-1"));
      },
    };
    const logs: string[] = [];
    const store = createMemoryStore();
    const engine = createEngine({
      store,
      registry: createExecutorRegistry([
        ...builtinExecutors,
        {
          name: "implement",
          execute: () => ({ status: "succeeded", output: "ok" }),
        },
        createPollExecutor({
          sources: [flaky],
          clock: h.clock,
          log: (line) => logs.push(line),
        }),
      ]),
      maxConcurrency: 4,
      graphProposalPolicy: pollGraphProposalPolicy,
    });
    const handle = engine.run(compile({ ...baseConfig, intervalSeconds: 60 }), {
      runId: "flaky",
    });
    await waitFor(() => logs.some((line) => line.includes("HTTP 502")));
    h.clock.advance(60_000);
    await waitFor(() => logs.some((line) => line.includes("queued A-1")));
    await handle.cancel();
    await handle.result;
  });

  test("fails fast when the engine does not allow graph proposals", async () => {
    const store = createMemoryStore();
    const engine = createEngine({
      store,
      registry: createExecutorRegistry([
        ...builtinExecutors,
        {
          name: "implement",
          execute: () => ({ status: "succeeded", output: "ok" }),
        },
        createPollExecutor({
          sources: [
            {
              kind: "fake",
              validateConfig() {},
              list: () =>
                Promise.resolve({
                  candidates: [{ key: "A-1", title: "Title A-1" }],
                  skipped: [],
                }),
              load: () => Promise.resolve(item("A-1")),
            },
          ],
        }),
      ]),
    });
    const outcome = await engine.run(compile(baseConfig)).result;
    expect(outcome).toMatchObject({
      status: "failed",
      failures: [
        {
          nodeId: "poll",
          cause: { code: "POLL_EXPANSION_UNAVAILABLE" },
          failureClass: "policy_denied",
        },
      ],
    });
  });

  test("reports items queued by an earlier session as already queued", async () => {
    const logs: string[] = [];
    const controller = new AbortController();
    const executor = createPollExecutor({
      sources: [
        {
          kind: "fake",
          validateConfig() {},
          list: () =>
            Promise.resolve({
              candidates: [
                { key: "OLD-1", title: "Title OLD-1" },
                { key: "NEW-2", title: "Title NEW-2" },
              ],
              skipped: [],
            }),
          load: (_config, candidate) => Promise.resolve(item(candidate.key)),
        },
      ],
      clock: createManualClock(),
      log: (line) => {
        logs.push(line);
        if (line.includes("matching")) controller.abort();
      },
    });
    const outcome = await executor.execute({
      runId: "r",
      nodeId: "poll",
      kind: "task",
      attempt: 2,
      inputs: [],
      config: parsePollConfig(baseConfig) as unknown as JsonValue,
      signal: controller.signal,
      reportPhase: () => Promise.resolve(),
      submitGraphProposal: (proposal) => {
        const replayed = proposal.id === "poll:fake:OLD-1";
        return Promise.resolve({
          status: "accepted",
          revision: {
            sequence: replayed ? 0 : 1,
            graphRevision: replayed ? 1 : 2,
            // A replay returns the revision decided in an earlier session.
            timestampMs: replayed ? 0 : Date.now(),
            proposal,
            decision: { status: "accepted", policy: "poll" },
            addedNodeIds: Object.keys(proposal.nodes),
          },
        });
      },
    });
    expect(outcome).toMatchObject({
      status: "failed",
      cause: { code: "POLL_STOPPED" },
    });
    expect(logs).toEqual([
      "poll tickets: already queued OLD-1: Title OLD-1",
      "poll tickets: queued NEW-2: Title NEW-2",
      "poll tickets: 2 matching, 1 newly queued",
    ]);
  });

  test("rejects a poll node whose source is not registered", () => {
    const executor = createPollExecutor({ sources: [] });
    expect(() =>
      executor.validateConfig?.(baseConfig as unknown as JsonValue),
    ).toThrow('unknown poll source "fake"');
  });
});
