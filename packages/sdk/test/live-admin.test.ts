import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  applyAdminRequestOffline,
  applyJitter,
  builtinExecutors,
  classifyWorkerFailure,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createManualClock,
  createMemoryStore,
  describeFailure,
  failureDisposition,
  inspectRun,
  isFailureRetryable,
  isResumableFailure,
  parseGraph,
  planAdminReset,
  transientInfraRetryPolicy,
} from "../src/index.js";
import type {
  AdminRequest,
  CompiledGraph,
  ExecutorDefinition,
  FailureClass,
  ManualClock,
  NodeExecutionOutcome,
  NodeFailure,
  NodeState,
  RunHandle,
  RunStore,
} from "../src/index.js";
import { createSqliteStore } from "../src/node/index.js";

const tempDir = mkdtempSync(join(tmpdir(), "prism-live-admin-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function buildGraph(definition: unknown): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainRetries(handle: RunHandle, clock: ManualClock) {
  let done = false;
  void handle.result.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  while (!done) {
    await settle();
    clock.advanceToNext();
  }
}

/** Returns `outcomes` in order, then succeeds. */
function scripted(
  name: string,
  outcomes: readonly NodeExecutionOutcome[],
): ExecutorDefinition & { calls: () => number } {
  let calls = 0;
  return {
    name,
    calls: () => calls,
    execute: () => {
      calls += 1;
      return (
        outcomes[calls - 1] ?? { status: "succeeded", output: `${name}-ok` }
      );
    },
  };
}

const provisioningFailure: NodeExecutionOutcome = {
  status: "failed",
  cause: {
    code: "CODEX_EXECUTION_FAILED",
    error: {
      name: "Error",
      message:
        "git worktree add failed: error: could not lock config file .git/config: File exists",
    },
  },
  failureClass: "transient_infra",
};

const adjudicatedBlocker: NodeExecutionOutcome = {
  status: "failed",
  cause: {
    code: "WORKER_FAILURE_ADJUDICATED",
    error:
      "B4 remains blocked at unchanged head a949: frozen CoreCommand lacks AgentUpdate ingress.\nThe bead requires stopping and reporting contract gaps.",
    reason: "review iteration budget exhausted (8)",
    state: {
      pullRequest: {
        number: 6,
        url: "https://github.com/example/repo/pull/6",
        state: "open",
      },
    },
  },
  failureClass: "semantic_failed",
};

describe("in-run transient retries (CLI default policy)", () => {
  function run(executor: ExecutorDefinition, maxRetries = 3) {
    const clock = createManualClock();
    const store = createMemoryStore();
    const engine = createEngine({
      store,
      registry: createExecutorRegistry([...builtinExecutors, executor]),
      retryPolicy: transientInfraRetryPolicy(maxRetries),
      clock,
      random: () => 0.5,
    });
    const handle = engine.run(
      buildGraph({
        version: 1,
        nodes: { n: { executor: executor.name } },
        finalNode: "n",
      }),
    );
    return { handle, clock, store };
  }

  test("a transient provisioning failure is retried in the same run to success", async () => {
    const executor = scripted("impl", [
      provisioningFailure,
      provisioningFailure,
    ]);
    const { handle, clock } = run(executor);
    await drainRetries(handle, clock);
    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "impl-ok",
    });
    expect(executor.calls()).toBe(3);
  });

  test("an adjudicated worker failure is never retried, whatever its class", async () => {
    const executor = scripted("impl", [
      { ...adjudicatedBlocker, failureClass: "transient_infra" },
    ]);
    const { handle, clock } = run(executor);
    await drainRetries(handle, clock);
    expect((await handle.result).status).toBe("failed");
    expect(executor.calls()).toBe(1);
  });

  test("unclassified, timeout and needs_input failures are not retried", async () => {
    for (const outcome of [
      { status: "failed", cause: "boom" },
      { status: "failed", cause: "slow", failureClass: "timeout" },
      { status: "failed", cause: "waiting", failureClass: "needs_input" },
    ] satisfies NodeExecutionOutcome[]) {
      const executor = scripted("impl", [outcome]);
      const { handle, clock } = run(executor);
      await drainRetries(handle, clock);
      expect((await handle.result).status).toBe("failed");
      expect(executor.calls()).toBe(1);
    }
  });

  test("--max-transient-retries 0 disables retries", async () => {
    const executor = scripted("impl", [provisioningFailure]);
    const { handle, clock } = run(executor, 0);
    await drainRetries(handle, clock);
    expect((await handle.result).status).toBe("failed");
    expect(executor.calls()).toBe(1);
  });

  test("policy and jitter helpers", () => {
    const policy = transientInfraRetryPolicy(3);
    expect(policy.maxAttempts).toBe(4);
    expect(isFailureRetryable(policy, { cause: "x" })).toBe(false);
    expect(
      isFailureRetryable(policy, {
        cause: "x",
        failureClass: "transient_infra",
      }),
    ).toBe(true);
    expect(applyJitter(1_000, 0.2, () => 0)).toBe(800);
    expect(applyJitter(1_000, 0.2, () => 0.999_999)).toBe(1_200);
    expect(applyJitter(1_000, undefined, () => 0)).toBe(1_000);
    expect(() => applyJitter(1_000, 1, () => 0)).toThrow();
    expect(() => transientInfraRetryPolicy(-1)).toThrow();
  });

  test("resume reopens only transient_infra failures, not timeouts", () => {
    expect(isResumableFailure({ cause: "x", failureClass: "timeout" })).toBe(
      false,
    );
    expect(
      isResumableFailure({ cause: "x", failureClass: "transient_infra" }),
    ).toBe(true);
    expect(
      isResumableFailure({ cause: "x", failureClass: "needs_input" }),
    ).toBe(false);
  });
});

/**
 * A node that blocks until released, keeping the coordinator live while a
 * test queues operator requests.
 */
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

const liveGraph = (): CompiledGraph =>
  buildGraph({
    version: 1,
    nodes: {
      root: { executor: "constant", config: { value: "r" } },
      impl: { executor: "impl", dependsOn: ["root"] },
      merge: { executor: "passthrough", dependsOn: ["impl"] },
      slow: { executor: "slow", dependsOn: ["root"] },
      final: {
        executor: "constant",
        config: { value: "all-done" },
        dependsOn: ["merge", "slow"],
      },
    },
    finalNode: "final",
  });

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
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
  // The run row is created asynchronously after engine.run returns.
  if ((await store.getRun(runId)) === undefined) return undefined;
  return (await inspectRun(store, runId)).nodes.find(
    (node) => node.nodeId === nodeId,
  )?.state;
}

async function resolvedRequest(
  store: RunStore,
  requestId: string,
): Promise<AdminRequest | undefined> {
  const request = await store.getAdminRequest?.(requestId);
  return request?.status === "pending" ? undefined : request;
}

describe.each([
  ["memory", (): RunStore => createMemoryStore()],
  [
    "sqlite",
    (): RunStore =>
      createSqliteStore({
        path: join(tempDir, `live-${String(Math.random()).slice(2)}.db`),
      }),
  ],
])("live operator requests (%s store)", (_label, makeStore) => {
  test("rerun-node on a failed node is applied by the live coordinator and re-runs in the same run", async () => {
    const store = makeStore();
    const impl = scripted("impl", [adjudicatedBlocker]);
    const slow = gate("slow");
    const engine = createEngine({
      store,
      registry: createExecutorRegistry([...builtinExecutors, impl, slow]),
      maxConcurrency: 4,
      adminPollIntervalMs: 10,
    });
    const handle = engine.run(liveGraph(), { runId: "live-1" });

    await waitFor(
      async () =>
        (await stateOf(store, "live-1", "merge")) === "blocked"
          ? true
          : undefined,
      "merge to block behind the failed impl",
    );

    await store.enqueueAdminRequest?.({
      requestId: "req-1",
      runId: "live-1",
      action: "rerun-node",
      nodeId: "impl",
    });
    const request = await waitFor(
      () => resolvedRequest(store, "req-1"),
      "the live coordinator to apply the request",
    );
    expect(request).toMatchObject({
      status: "applied",
      resolvedBy: "live",
      // final was blocked behind merge, so it is reset too.
      resetNodeIds: ["impl", "merge", "final"],
    });

    await waitFor(
      async () =>
        (await stateOf(store, "live-1", "merge")) === "succeeded"
          ? true
          : undefined,
      "impl and merge to re-run",
    );
    slow.release();
    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "all-done",
    });
    expect(impl.calls()).toBe(2);
    const events = (await inspectRun(store, "live-1")).nodes;
    expect(events.every((node) => node.state === "succeeded")).toBe(true);
    await store.close?.();
  });

  test("a live request against running or succeeded work is rejected with a reason", async () => {
    const store = makeStore();
    const impl = scripted("impl", []);
    const slow = gate("slow");
    const engine = createEngine({
      store,
      registry: createExecutorRegistry([...builtinExecutors, impl, slow]),
      maxConcurrency: 4,
      adminPollIntervalMs: 10,
    });
    const handle = engine.run(liveGraph(), { runId: "live-2" });
    await waitFor(
      async () =>
        (await stateOf(store, "live-2", "slow")) === "running"
          ? true
          : undefined,
      "slow to start",
    );

    await store.enqueueAdminRequest?.({
      requestId: "req-running",
      runId: "live-2",
      action: "signal",
      nodeId: "slow",
    });
    const rejected = await waitFor(
      () => resolvedRequest(store, "req-running"),
      "rejection",
    );
    expect(rejected).toMatchObject({ status: "rejected", resolvedBy: "live" });
    expect(rejected.message).toContain("is running");

    slow.release();
    await expect(handle.result).resolves.toMatchObject({ status: "succeeded" });
    await store.close?.();
  });
});

describe("offline fallback", () => {
  test("applies a request to a finished run, reopening it for resume", async () => {
    const store = createMemoryStore();
    const impl = scripted("impl", [adjudicatedBlocker]);
    const engine = createEngine({
      store,
      registry: createExecutorRegistry([...builtinExecutors, impl]),
    });
    const graph = buildGraph({
      version: 1,
      nodes: {
        impl: { executor: "impl" },
        after: { executor: "passthrough", dependsOn: ["impl"] },
      },
      finalNode: "after",
    });
    const first = engine.run(graph, { runId: "off-1" });
    expect((await first.result).status).toBe("failed");

    await store.enqueueAdminRequest?.({
      requestId: "off-req",
      runId: "off-1",
      action: "rerun-node",
      nodeId: "impl",
    });
    const result = await applyAdminRequestOffline(store, "off-req");
    expect(result.resolvedNow).toBe(true);
    expect(result.request).toMatchObject({
      status: "applied",
      resolvedBy: "offline",
      resetNodeIds: ["impl", "after"],
    });
    expect((await store.getRun("off-1"))?.finished).toBe(false);

    const resumed = engine.resume("off-1");
    await expect(resumed.result).resolves.toEqual({
      status: "succeeded",
      output: "impl-ok",
    });
    // Applying again is a no-op: the request is no longer pending.
    expect((await applyAdminRequestOffline(store, "off-req")).resolvedNow).toBe(
      false,
    );
  });

  test("offline application is refused while a coordinator owns the run", async () => {
    const store = createMemoryStore();
    await store.createRun({
      runId: "held",
      graph: buildGraph({
        version: 1,
        nodes: { a: { executor: "constant", config: { value: 1 } } },
        finalNode: "a",
      }),
    });
    await store.acquireCoordinatorLease("held", "someone-else", 60_000);
    await store.enqueueAdminRequest?.({
      requestId: "held-req",
      runId: "held",
      action: "signal",
      nodeId: "a",
    });
    await expect(applyAdminRequestOffline(store, "held-req")).rejects.toThrow(
      /active coordinator lease/u,
    );
  });
});

describe("planAdminReset", () => {
  const graph = buildGraph({
    version: 1,
    nodes: {
      a: { executor: "constant", config: { value: 1 } },
      b: { executor: "passthrough", dependsOn: ["a"] },
      c: { executor: "passthrough", dependsOn: ["b"] },
      d: { executor: "passthrough", dependsOn: ["a"] },
    },
    finalNode: "c",
  });
  const states = new Map<string, NodeState>([
    ["a", "failed"],
    ["b", "blocked"],
    ["c", "blocked"],
    ["d", "failed"],
  ]);

  test("live signal resets the target and its blocked/skipped descendants", () => {
    expect(planAdminReset(graph, states, "signal", "a", "live")).toEqual({
      ok: true,
      nodeIds: ["a", "b", "c"],
    });
  });

  test("live rerun-node also resets failed descendants", () => {
    expect(planAdminReset(graph, states, "rerun-node", "a", "live")).toEqual({
      ok: true,
      nodeIds: ["a", "b", "c", "d"],
    });
  });

  test("live rejects succeeded and running targets; offline allows them", () => {
    const running = new Map(states).set("a", "running");
    expect(planAdminReset(graph, running, "signal", "a", "live").ok).toBe(
      false,
    );
    const succeeded = new Map(states).set("a", "succeeded");
    expect(planAdminReset(graph, succeeded, "signal", "a", "offline")).toEqual({
      ok: true,
      nodeIds: ["a", "b", "c"],
    });
    expect(planAdminReset(graph, states, "signal", "ghost", "live").ok).toBe(
      false,
    );
  });
});

describe("sqlite admin requests", () => {
  test("enqueue, list, fenced resolve with events, cancel, and reopen", async () => {
    const path = join(tempDir, "admin-contract.db");
    const store = createSqliteStore({ path });
    const graph = buildGraph({
      version: 1,
      nodes: { a: { executor: "constant", config: { value: 1 } } },
      finalNode: "a",
    });
    await store.createRun({ runId: "r", graph });
    await store.appendEvents("r", [{ kind: "node_ready", nodeId: "a" }]);
    await store.finishRun("r", { status: "failed", failures: [] });

    await store.enqueueAdminRequest?.({
      requestId: "q1",
      runId: "r",
      action: "signal",
      nodeId: "a",
    });
    await store.enqueueAdminRequest?.({
      requestId: "q2",
      runId: "r",
      action: "signal",
      nodeId: "a",
    });
    await expect(
      store.enqueueAdminRequest?.({
        requestId: "q1",
        runId: "r",
        action: "signal",
        nodeId: "a",
      }),
    ).rejects.toThrow(/already exists/u);
    expect(
      (await store.listPendingAdminRequests?.("r"))?.map((q) => q.requestId),
    ).toEqual(["q1", "q2"]);

    const lease = await store.acquireCoordinatorLease("r", "owner", 60_000);
    // A stale expected revision writes nothing.
    await expect(
      store.resolveAdminRequest?.(
        {
          requestId: "q1",
          status: "applied",
          resolvedBy: "offline",
          events: [{ kind: "node_reset", nodeId: "a" }],
          expectedRevision: 0,
          reopen: true,
        },
        lease,
      ),
    ).rejects.toThrow(/revision conflict/u);
    expect((await store.getAdminRequest?.("q1"))?.status).toBe("pending");

    const applied = await store.resolveAdminRequest?.(
      {
        requestId: "q1",
        status: "applied",
        resolvedBy: "offline",
        resetNodeIds: ["a"],
        events: [{ kind: "node_reset", nodeId: "a" }],
        expectedRevision: 1,
        reopen: true,
      },
      lease,
    );
    expect(applied?.resolved).toBe(true);
    expect(applied?.persisted.map((event) => event.seq)).toEqual([1]);
    expect((await store.getRun("r"))?.finished).toBe(false);

    // Compare-and-set: a second resolution of q1 writes nothing.
    const again = await store.resolveAdminRequest?.(
      { requestId: "q1", status: "rejected", resolvedBy: "live" },
      lease,
    );
    expect(again?.resolved).toBe(false);
    expect(again?.request.status).toBe("applied");

    expect((await store.cancelAdminRequest?.("q2", "withdrawn"))?.status).toBe(
      "cancelled",
    );
    expect(await store.listPendingAdminRequests?.("r")).toEqual([]);
    await store.releaseLease(lease);
    await store.close?.();

    // The queue survives reopening the file.
    const reopened = createSqliteStore({ path });
    expect(await reopened.getAdminRequest?.("q1")).toMatchObject({
      status: "applied",
      resetNodeIds: ["a"],
    });
    await reopened.close?.();
  });

  test("a read-only open does not create the admin table", async () => {
    const path = join(tempDir, "readonly-open.db");
    const writer = createSqliteStore({ path });
    await writer.createRun({
      runId: "x",
      graph: buildGraph({
        version: 1,
        nodes: { a: { executor: "constant", config: { value: 1 } } },
        finalNode: "a",
      }),
    });
    await writer.close?.();
    const reader = createSqliteStore({ path });
    expect(await reader.getAdminRequest?.("nope")).toBeUndefined();
    expect(await reader.listPendingAdminRequests?.("x")).toEqual([]);
    await reader.close?.();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_requests'",
        )
        .get(),
    ).toBeUndefined();
    raw.close();
  });
});

describe("failure disposition", () => {
  const blocker: NodeFailure = {
    nodeId: "implement-b4",
    cause:
      adjudicatedBlocker.status === "failed" ? adjudicatedBlocker.cause : null,
    failureClass: "semantic_failed",
  };

  test("a worker-declared blocker reads as needs input, with summary and PR", () => {
    expect(failureDisposition(blocker)).toBe("needs_input");
    expect(describeFailure(blocker, { runId: "r1", finished: false })).toEqual({
      nodeId: "implement-b4",
      disposition: "needs_input",
      summary:
        "B4 remains blocked at unchanged head a949: frozen CoreCommand lacks AgentUpdate ingress.",
      pullRequestUrl: "https://github.com/example/repo/pull/6",
      hint: "resolve the blocker, then: prism rerun-node r1 implement-b4",
    });
  });

  test("explicit needs_input, transient and genuine failures", () => {
    expect(
      failureDisposition({
        nodeId: "n",
        cause: "x",
        failureClass: "needs_input",
      }),
    ).toBe("needs_input");
    const transient: NodeFailure = {
      nodeId: "n",
      cause:
        provisioningFailure.status === "failed"
          ? provisioningFailure.cause
          : null,
      failureClass: "transient_infra",
    };
    expect(
      describeFailure(transient, { runId: "r", finished: true }),
    ).toMatchObject({
      disposition: "transient",
      hint: "transient — prism resume r re-runs it",
    });
    expect(
      describeFailure(transient, { runId: "r", finished: false }).hint,
    ).toBe(
      "transient, retries exhausted — prism rerun-node r n retries it now",
    );
    expect(
      describeFailure(
        {
          nodeId: "n",
          cause: { message: "tests failed" },
          failureClass: "validation_failed",
        },
        { runId: "r", finished: true },
      ),
    ).toMatchObject({
      disposition: "genuine",
      summary: "tests failed",
      hint: "inspect the logs: prism logs r",
    });
  });

  test("recording-time classification of worker failures", () => {
    const cases: [
      Parameters<typeof classifyWorkerFailure>[0],
      FailureClass | undefined,
    ][] = [
      [{ error: "x", failureClass: "needs_input" }, "needs_input"],
      [
        {
          error: "stopped: blocked on a frozen contract",
          failureClass: "semantic_failed",
        },
        "needs_input",
      ],
      [
        { error: "tests failed", failureClass: "validation_failed" },
        "validation_failed",
      ],
      [{ error: "tests failed" }, undefined],
    ];
    for (const [input, expected] of cases) {
      expect(classifyWorkerFailure(input)).toBe(expected);
    }
  });
});
