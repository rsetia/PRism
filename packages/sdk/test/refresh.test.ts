import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, test } from "vitest";
import {
  applyAdminRequestOffline,
  buildBeadsGraph,
  buildRefreshRevision,
  builtinExecutors,
  compileGraph,
  compileRefresh,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  inspectRun,
  isRefreshRevision,
  parseGraph,
  planRefreshReset,
  refreshBeadsNodeConfigs,
} from "../src/index.js";
import type {
  AdminRequest,
  Bead,
  CompiledGraph,
  ExecutionContext,
  ExecutorDefinition,
  GraphRefresh,
  JsonValue,
  NodeExecutionOutcome,
  NodeState,
  RunStore,
} from "../src/index.js";
import { createSqliteStore } from "../src/node/index.js";

const tempDir = mkdtempSync(join(tmpdir(), "prism-refresh-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function compile(
  definition: ReturnType<typeof buildBeadsGraph>,
): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

const beadV1: Bead = {
  id: "xondom-kko.9",
  title: "B4: ACP proxy chain",
  status: "open",
  description: "v1: stop and report contract gaps",
};
const beadV2: Bead = {
  ...beadV1,
  title: "B4: ACP proxy chain (after A2.1)",
  description: "v2: use RecordAgentUpdate/RecordToolCall",
};

/**
 * A Beads graph (context → implement) plus an independent `slow` branch so
 * a live run stays open while the operator refreshes the failed node.
 */
function beadsGraph(withSlow = false): CompiledGraph {
  const definition = buildBeadsGraph([beadV1], {
    review: "none",
    targetBranch: "integration",
    validationCommands: ["scripts/verify.sh"],
    includeMerge: false,
    includeBeadsUpdate: false,
    spec: { source: "/spec/v1.md", content: "SPEC v1" },
  });
  if (!withSlow) return compile(definition);
  return compile({
    ...definition,
    nodes: {
      ...definition.nodes,
      slow: { executor: "slow", dependsOn: [] },
      done: {
        executor: "constant",
        dependsOn: [definition.finalNode ?? IMPL, "slow"],
        config: { value: "all-done" },
      },
    },
    finalNode: "done",
  });
}

const IMPL = "implement-xondom-kko-9";
const CTX = "context-xondom-kko-9";

const blocker: NodeExecutionOutcome = {
  status: "failed",
  cause: {
    code: "WORKER_FAILURE_ADJUDICATED",
    error: "B4 remains blocked: frozen CoreCommand lacks ingress",
  },
  failureClass: "needs_input",
};

/** Fails once, then succeeds; records the context text and title it saw. */
function recordingImplement(): ExecutorDefinition & {
  readonly seen: { description: unknown; title: unknown; spec: unknown }[];
} {
  const seen: { description: unknown; title: unknown; spec: unknown }[] = [];
  return {
    name: "implement",
    seen,
    execute: (context: ExecutionContext) => {
      const input = context.inputs[0] as Record<string, JsonValue>;
      const config = context.config as Record<string, JsonValue>;
      const workItem = config["workItem"] as Record<string, JsonValue>;
      const spec = input["specDocument"] as Record<string, JsonValue>;
      seen.push({
        description: input["description"],
        title: workItem["title"],
        spec: spec["content"],
      });
      return seen.length === 1
        ? blocker
        : { status: "succeeded", output: "implemented" };
    },
  };
}

function gate(name: string): ExecutorDefinition & { release: () => void } {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    name,
    release: () => {
      release();
    },
    execute: async () => {
      await opened;
      return { status: "succeeded", output: `${name}-done` };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function stateOf(
  store: RunStore,
  runId: string,
  nodeId: string,
): Promise<NodeState | undefined> {
  if ((await store.getRun(runId)) === undefined) return undefined;
  return (await inspectRun(store, runId)).nodes.find(
    (node) => node.nodeId === nodeId,
  )?.state;
}

async function resolved(
  store: RunStore,
  requestId: string,
): Promise<AdminRequest | undefined> {
  const request = await store.getAdminRequest?.(requestId);
  return request?.status === "pending" ? undefined : request;
}

describe("refresh configs (pure)", () => {
  test("refreshBeadsNodeConfigs re-snapshots the bead and keeps every setting", () => {
    const graph = beadsGraph();
    const refresh = refreshBeadsNodeConfigs(graph, IMPL, beadV2);
    expect(Object.keys(refresh.configs).sort()).toEqual([CTX, IMPL]);
    const context = refresh.configs[CTX] as { value: Record<string, unknown> };
    expect(context.value["description"]).toBe(beadV2.description);
    // No new spec given: the frozen spec is kept.
    expect(context.value["specDocument"]).toEqual({
      source: "/spec/v1.md",
      content: "SPEC v1",
    });
    const implement = refresh.configs[IMPL] as Record<string, unknown>;
    expect(implement["workItem"]).toMatchObject({ title: beadV2.title });
    expect(implement["targetBranch"]).toBe("integration");
    expect(implement["validationCommands"]).toEqual(["scripts/verify.sh"]);

    const withSpec = refreshBeadsNodeConfigs(graph, IMPL, beadV2, {
      source: "/spec/v2.md",
      content: "SPEC v2",
    });
    expect(
      (withSpec.configs[CTX] as { value: Record<string, unknown> }).value[
        "specDocument"
      ],
    ).toEqual({ source: "/spec/v2.md", content: "SPEC v2" });
    expect(withSpec.source).toEqual({
      workItemId: "xondom-kko.9",
      specSource: "/spec/v2.md",
    });

    const compiled = compileRefresh(graph, refresh);
    expect(compiled.refreshedNodeIds).toEqual([CTX, IMPL]);
    expect(compiled.graph.order).toEqual(graph.order);
    expect(compiled.graph.nodes[IMPL]?.dependsOn).toEqual(
      graph.nodes[IMPL]?.dependsOn,
    );
  });

  test("refuses a different work item, changed settings, foreign nodes and non-Beads targets", () => {
    const graph = beadsGraph(true);
    expect(() =>
      refreshBeadsNodeConfigs(graph, IMPL, { ...beadV2, id: "xondom-kko.7" }),
    ).toThrow(/does not match the node's work item/u);
    expect(() => refreshBeadsNodeConfigs(graph, "slow", beadV2)).toThrow(
      /Beads-backed nodes only/u,
    );

    const good = refreshBeadsNodeConfigs(graph, IMPL, beadV2);
    const implement = good.configs[IMPL] as Record<string, JsonValue>;
    const changedSettings: GraphRefresh = {
      ...good,
      configs: {
        ...good.configs,
        [IMPL]: { ...implement, targetBranch: "main" },
      },
    };
    expect(() => compileRefresh(graph, changedSettings)).toThrow(
      /settings must stay unchanged/u,
    );
    const otherItem: GraphRefresh = {
      ...good,
      configs: {
        ...good.configs,
        [IMPL]: {
          ...implement,
          workItem: { provider: "beads", id: "xondom-kko.7" },
        },
      },
    };
    expect(() => compileRefresh(graph, otherItem)).toThrow(
      /expected beads:xondom-kko.9/u,
    );
    const foreign: GraphRefresh = {
      ...good,
      configs: { ...good.configs, done: { value: "changed" } },
    };
    expect(() => compileRefresh(graph, foreign)).toThrow(
      /inputs only it consumes/u,
    );
  });

  test("planRefreshReset refuses running and succeeded targets and resets the context input", () => {
    const graph = beadsGraph();
    const refresh = refreshBeadsNodeConfigs(graph, IMPL, beadV2);
    const states = (impl: NodeState) =>
      new Map<string, NodeState>([
        [CTX, "succeeded"],
        [IMPL, impl],
      ]);
    for (const mode of ["live", "offline"] as const) {
      expect(
        planRefreshReset(graph, states("running"), "rerun-node", refresh, mode),
      ).toMatchObject({ ok: false });
      expect(
        planRefreshReset(
          graph,
          states("succeeded"),
          "rerun-node",
          refresh,
          mode,
        ),
      ).toMatchObject({ ok: false });
      expect(
        planRefreshReset(graph, states("failed"), "rerun-node", refresh, mode),
      ).toEqual({ ok: true, nodeIds: [CTX, IMPL] });
    }
  });

  test("buildRefreshRevision is an audited, accepted, node-free revision", () => {
    const graph = beadsGraph();
    const revision = buildRefreshRevision(
      graph,
      refreshBeadsNodeConfigs(graph, IMPL, beadV2),
      { id: "refresh:x", proposer: "operator:rerun-node --refresh" },
    );
    expect(isRefreshRevision(revision)).toBe(true);
    expect(revision.addedNodeIds).toEqual([]);
    expect(revision.refreshedNodeIds).toEqual([CTX, IMPL]);
    expect(revision.decision).toEqual({
      status: "accepted",
      policy: "operator-refresh",
    });
  });
});

describe.each([
  ["memory", (): RunStore => createMemoryStore()],
  [
    "sqlite",
    (): RunStore =>
      createSqliteStore({
        path: join(tempDir, `refresh-${String(Math.random()).slice(2)}.db`),
      }),
  ],
])("rerun-node --refresh (%s store)", (_label, makeStore) => {
  test("offline: a failed node re-runs in the same run with the new Bead text", async () => {
    const store = makeStore();
    const implement = recordingImplement();
    const engine = createEngine({
      store,
      registry: createExecutorRegistry([...builtinExecutors, implement]),
    });
    const graph = beadsGraph();
    const first = await engine.run(graph, { runId: "off" }).result;
    expect(first.status).toBe("failed");

    const stored = await store.getRun("off");
    if (stored === undefined) throw new Error("run missing");
    await store.enqueueAdminRequest?.({
      requestId: "off-refresh",
      runId: "off",
      action: "rerun-node",
      nodeId: IMPL,
      refresh: refreshBeadsNodeConfigs(stored.graph, IMPL, beadV2, {
        source: "/spec/v2.md",
        content: "SPEC v2",
      }),
    });
    const applied = await applyAdminRequestOffline(store, "off-refresh");
    expect(applied.request).toMatchObject({
      status: "applied",
      resolvedBy: "offline",
      resetNodeIds: [CTX, IMPL],
    });
    const reopened = await store.getRun("off");
    expect(reopened?.finished).toBe(false);
    expect(reopened?.graphRevision).toBe(1);
    expect(
      (reopened?.graph.nodes[CTX]?.config as { value: Record<string, unknown> })
        .value["description"],
    ).toBe(beadV2.description);

    await expect(engine.resume("off").result).resolves.toEqual({
      status: "succeeded",
      output: "implemented",
    });
    expect(implement.seen).toEqual([
      { description: beadV1.description, title: beadV1.title, spec: "SPEC v1" },
      { description: beadV2.description, title: beadV2.title, spec: "SPEC v2" },
    ]);

    // Replay/inspect: the refresh is an audited graph revision.
    const inspection = await inspectRun(store, "off");
    const refreshes = (inspection.graphRevisions ?? []).filter((revision) =>
      isRefreshRevision(revision),
    );
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({
      graphRevision: 1,
      refreshedNodeIds: [CTX, IMPL],
      proposal: {
        proposer: "operator:rerun-node --refresh",
        refresh: { targetNodeId: IMPL },
      },
    });
    // The original failure stays in the event log.
    expect(inspection.nodes.every((node) => node.state === "succeeded")).toBe(
      true,
    );
    await store.close?.();
  });

  test("live: the coordinator applies the refresh and re-runs the node with new input", async () => {
    const store = makeStore();
    const implement = recordingImplement();
    const slow = gate("slow");
    const engine = createEngine({
      store,
      registry: createExecutorRegistry([...builtinExecutors, implement, slow]),
      maxConcurrency: 4,
      adminPollIntervalMs: 10,
    });
    const graph = beadsGraph(true);
    const handle = engine.run(graph, { runId: "live" });
    await waitFor(
      async () =>
        (await stateOf(store, "live", IMPL)) === "failed" ? true : undefined,
      "the first attempt to fail",
    );

    await store.enqueueAdminRequest?.({
      requestId: "live-refresh",
      runId: "live",
      action: "rerun-node",
      nodeId: IMPL,
      refresh: refreshBeadsNodeConfigs(graph, IMPL, beadV2),
    });
    const request = await waitFor(
      () => resolved(store, "live-refresh"),
      "the live coordinator to apply the refresh",
    );
    expect(request).toMatchObject({
      status: "applied",
      resolvedBy: "live",
      resetNodeIds: [CTX, IMPL, "done"],
    });
    await waitFor(
      async () =>
        (await stateOf(store, "live", IMPL)) === "succeeded" ? true : undefined,
      "the refreshed node to re-run",
    );
    slow.release();
    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "all-done",
    });
    expect(implement.seen.at(-1)).toEqual({
      description: beadV2.description,
      title: beadV2.title,
      spec: "SPEC v1",
    });
    expect((await store.getRun("live"))?.graphRevision).toBe(1);
    await store.close?.();
  });

  test("refusals: a succeeded node, or a refresh that would touch another node", async () => {
    const store = makeStore();
    const implement: ExecutorDefinition = {
      name: "implement",
      execute: () => ({ status: "succeeded", output: "ok" }),
    };
    const engine = createEngine({
      store,
      registry: createExecutorRegistry([...builtinExecutors, implement]),
    });
    const graph = beadsGraph();
    expect((await engine.run(graph, { runId: "done" }).result).status).toBe(
      "succeeded",
    );
    await store.enqueueAdminRequest?.({
      requestId: "done-refresh",
      runId: "done",
      action: "rerun-node",
      nodeId: IMPL,
      refresh: refreshBeadsNodeConfigs(graph, IMPL, beadV2),
    });
    const rejected = await applyAdminRequestOffline(store, "done-refresh");
    expect(rejected.request).toMatchObject({ status: "rejected" });
    expect(rejected.request.message).toMatch(/is succeeded/u);
    // Nothing changed: no revision, run still finished.
    expect((await store.getRun("done"))?.graphRevision).toBe(0);
    expect((await store.getRun("done"))?.finished).toBe(true);

    const good = refreshBeadsNodeConfigs(graph, IMPL, beadV2);
    await store.enqueueAdminRequest?.({
      requestId: "mismatch",
      runId: "done",
      action: "rerun-node",
      nodeId: CTX,
      refresh: good,
    });
    const mismatch = await applyAdminRequestOffline(store, "mismatch");
    expect(mismatch.request).toMatchObject({ status: "rejected" });
    expect(mismatch.request.message).toMatch(/refresh targets/u);
    await store.close?.();
  });
});

describe("sqlite: refresh persistence", () => {
  test("refresh payloads and revisions survive reopen; an older admin table gains the column", async () => {
    const path = join(tempDir, "legacy-admin.db");
    const first = createSqliteStore({ path });
    const graph = beadsGraph();
    await first.createRun({ runId: "legacy", graph });
    await first.close?.();

    // An admin_requests table created by a release without refresh support.
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE admin_requests (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('signal', 'rerun-node')),
        node_id TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('pending', 'applied', 'rejected', 'cancelled')),
        created_at_ms INTEGER NOT NULL,
        resolved_by TEXT
          CHECK (resolved_by IS NULL OR resolved_by IN ('live', 'offline')),
        resolved_at_ms INTEGER,
        reset_node_ids_json TEXT,
        message TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO admin_requests (request_id, run_id, action, node_id, status, created_at_ms)
        VALUES ('old', 'legacy', 'signal', '${IMPL}', 'cancelled', 1);
    `);
    raw.close();

    const store = createSqliteStore({ path });
    expect((await store.getAdminRequest?.("old"))?.refresh).toBeUndefined();
    const refresh = refreshBeadsNodeConfigs(graph, IMPL, beadV2);
    await store.enqueueAdminRequest?.({
      requestId: "new",
      runId: "legacy",
      action: "rerun-node",
      nodeId: IMPL,
      refresh,
    });
    expect((await store.getAdminRequest?.("new"))?.refresh).toEqual(refresh);
    const applied = await applyAdminRequestOffline(store, "new");
    expect(applied.request.status).toBe("applied");
    await store.close?.();

    const reopened = createSqliteStore({ path });
    const run = await reopened.getRun("legacy");
    expect(run?.graphRevision).toBe(1);
    expect(
      (
        run?.graph.nodes[IMPL]?.config as Record<
          string,
          Record<string, unknown>
        >
      )["workItem"]?.["title"],
    ).toBe(beadV2.title);
    const revisions = (await reopened.listGraphRevisions?.("legacy")) ?? [];
    expect(revisions.map((revision) => isRefreshRevision(revision))).toEqual([
      true,
    ]);
    expect((await reopened.getAdminRequest?.("new"))?.refresh).toEqual(refresh);
    await reopened.close?.();
  });
});
