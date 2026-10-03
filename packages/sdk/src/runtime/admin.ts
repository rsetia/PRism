import type { CompiledGraph } from "../graph/types.js";
import type { RunEvent } from "./events.js";
import { buildRefreshRevision } from "./graph-revision.js";
import type { GraphRefresh, GraphRevision } from "./graph-revision.js";
import type {
  AdminRequest,
  AdminRequestAction,
  RunLease,
  RunStore,
} from "./ports.js";
import { isResumableFailure } from "./retry.js";
import { reduceNodeState } from "./transitions.js";
import { TERMINAL_NODE_STATES } from "./types.js";
import type { NodeFailure, NodeState } from "./types.js";

/**
 * Administrative recovery operations (plan §16). These mutate a run's
 * event log directly — outside the engine — to unstick or re-run work.
 * They are the deliberate, sanctioned break from "only the engine changes
 * state"; a live engine must not be running the same run concurrently.
 */

/** Read a bounded snapshot and fold it into current node states. */
async function replayStates(
  store: RunStore,
  runId: string,
): Promise<{
  states: Map<string, NodeState>;
  order: readonly string[];
  failures: readonly NodeFailure[];
}> {
  const stored = await store.getRun(runId);
  if (stored === undefined) {
    throw new Error(`unknown run: "${runId}"`);
  }

  const states = new Map<string, NodeState>();
  const failureByNode = new Map<string, NodeFailure>();
  for (const nodeId of stored.graph.order) {
    states.set(nodeId, "pending");
  }

  const iterator = store.readEvents(runId)[Symbol.asyncIterator]();
  try {
    for (let seq = 0; seq < stored.revision; seq += 1) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      const previous = states.get(event.nodeId);
      if (previous === undefined) {
        throw new Error(`stored event targets unknown node "${event.nodeId}"`);
      }
      states.set(event.nodeId, reduceNodeState(previous, event));
      if (event.kind === "node_failed") {
        failureByNode.set(event.nodeId, event.failure);
      } else if (event.kind === "node_reset") {
        failureByNode.delete(event.nodeId);
      }
    }
  } finally {
    await iterator.return?.();
  }

  const failures = stored.graph.order.flatMap((nodeId) => {
    const failure = failureByNode.get(nodeId);
    return failure === undefined ? [] : [failure];
  });
  return { states, order: stored.graph.order, failures };
}

/**
 * Force an interrupted or orphaned run to a terminal, cancelled state.
 * Every non-terminal node is driven to `cancelled` and the run is
 * finished. Use this when a run's workers are gone and it will never
 * complete on its own.
 *
 * Rejects an unknown run. A run that is already finished is left as-is.
 */
export async function abortRun(store: RunStore, runId: string): Promise<void> {
  const stored = await store.getRun(runId);
  if (stored === undefined) {
    throw new Error(`unknown run: "${runId}"`);
  }
  if (stored.finished) {
    return;
  }

  await withAdministrativeCoordinatorLease(
    store,
    runId,
    "abort",
    async (currentLease) => {
      const locked = await store.getRun(runId);
      if (locked === undefined) throw new Error(`unknown run: "${runId}"`);
      if (locked.finished) return;

      const { states, order, failures } = await replayStates(store, runId);
      const events: RunEvent[] = [];
      for (const nodeId of order) {
        const state = states.get(nodeId);
        if (state === undefined || TERMINAL_NODE_STATES.has(state)) {
          continue;
        }
        // running/cancelling cannot go straight to cancelled — pass through
        // cancelling first; pending/ready/retry_wait cancel directly.
        if (state === "running") {
          events.push({ kind: "node_cancelling", nodeId });
        }
        events.push({ kind: "node_cancelled", nodeId });
      }

      if (events.length > 0) {
        await store.appendEvents(
          runId,
          events,
          undefined,
          await currentLease(),
        );
      }
      await store.finishRun(
        runId,
        {
          status: "cancelled",
          reason: null,
          failures,
        },
        await currentLease(),
      );
    },
  );
}

/**
 * Nodes a plain `resume` should re-run on a finished run: those currently
 * `failed` with a resumable failure (see isResumableFailure). Their recorded
 * failures stay in the event log; resetRun only appends node_reset events.
 */
export async function resumableFailedNodes(
  store: RunStore,
  runId: string,
): Promise<string[]> {
  const { states, order, failures } = await replayStates(store, runId);
  const failureByNode = new Map(
    failures.map((failure) => [failure.nodeId, failure]),
  );
  return order.filter((nodeId) => {
    if (states.get(nodeId) !== "failed") return false;
    const failure = failureByNode.get(nodeId);
    return failure !== undefined && isResumableFailure(failure);
  });
}

export interface ResetRunOptions {
  /** Also reset every transitive dependent of each target node. */
  readonly includeDownstream?: boolean;
}

/**
 * Reset nodes so a later resume re-runs them (plan §16, signal /
 * rerun-node). Each target — and, with includeDownstream, its transitive
 * dependents — gets a node_reset event, and the run is reopened so it can
 * be resumed. Does not itself run anything.
 *
 * Rejects an unknown run or an unknown node id.
 */
export async function resetRun(
  store: RunStore,
  runId: string,
  nodeIds: readonly string[],
  options: ResetRunOptions = {},
): Promise<void> {
  const stored = await store.getRun(runId);
  if (stored === undefined) {
    throw new Error(`unknown run: "${runId}"`);
  }
  const graph = stored.graph;
  for (const nodeId of nodeIds) {
    if (graph.nodes[nodeId] === undefined) {
      throw new Error(`unknown node "${nodeId}" in run "${runId}"`);
    }
  }
  await withAdministrativeCoordinatorLease(
    store,
    runId,
    "reset",
    async (currentLease) => {
      const locked = await store.getRun(runId);
      if (locked === undefined) throw new Error(`unknown run: "${runId}"`);
      const lockedGraph = locked.graph;
      for (const nodeId of nodeIds) {
        if (lockedGraph.nodes[nodeId] === undefined) {
          throw new Error(`unknown node "${nodeId}" in run "${runId}"`);
        }
      }

      const targets = new Set<string>();
      const visit = (nodeId: string): void => {
        if (targets.has(nodeId)) return;
        targets.add(nodeId);
        if (options.includeDownstream === true) {
          for (const dependentId of lockedGraph.nodes[nodeId]?.dependents ??
            []) {
            visit(dependentId);
          }
        }
      };
      for (const nodeId of nodeIds) visit(nodeId);

      // The run must accept appends; reopen it if it had finished.
      if (locked.finished) {
        await store.reopenRun(runId, await currentLease());
      }

      const events: RunEvent[] = lockedGraph.order
        .filter((nodeId) => targets.has(nodeId))
        .map((nodeId) => ({ kind: "node_reset", nodeId }));
      if (events.length > 0) {
        await store.appendEvents(
          runId,
          events,
          undefined,
          await currentLease(),
        );
      }
    },
  );
}

/** States a live coordinator may reset a target node out of. */
export const LIVE_RESETTABLE_STATES: ReadonlySet<NodeState> =
  new Set<NodeState>(["failed", "blocked", "cancelled", "skipped"]);

export type AdminResetPlan =
  | { readonly ok: true; readonly nodeIds: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Which nodes an admin request resets (pure).
 *
 * - `live`: the target must be failed, blocked, cancelled or skipped —
 *   resetting running or succeeded work under a live coordinator is
 *   rejected. Descendants are reset only when no live work would be lost:
 *   `signal` resets blocked and skipped descendants (so they can run once
 *   the target succeeds); `rerun-node` also resets failed and cancelled
 *   ones. Running, succeeded, pending and ready descendants are left alone.
 * - `offline`: no coordinator is running, so any target state is allowed
 *   (the historical behaviour). `signal` additionally resets blocked and
 *   skipped descendants; `rerun-node` resets every transitive dependent.
 *
 * Returned ids are in graph order.
 */
export function planAdminReset(
  graph: CompiledGraph,
  states: ReadonlyMap<string, NodeState>,
  action: AdminRequestAction,
  nodeId: string,
  mode: "live" | "offline",
): AdminResetPlan {
  if (graph.nodes[nodeId] === undefined) {
    return { ok: false, message: `unknown node "${nodeId}"` };
  }
  const state = states.get(nodeId);
  if (
    mode === "live" &&
    (state === undefined || !LIVE_RESETTABLE_STATES.has(state))
  ) {
    return {
      ok: false,
      message: `node "${nodeId}" is ${state ?? "unknown"}; a live run can only reset failed, blocked, cancelled or skipped nodes`,
    };
  }
  const descendantStates: ReadonlySet<NodeState> | "all" =
    mode === "offline" && action === "rerun-node"
      ? "all"
      : action === "rerun-node"
        ? LIVE_RESETTABLE_STATES
        : new Set<NodeState>(["blocked", "skipped"]);

  const targets = new Set<string>([nodeId]);
  const seen = new Set<string>([nodeId]);
  const queue = [...(graph.nodes[nodeId]?.dependents ?? [])];
  while (queue.length > 0) {
    const dependentId = queue.shift() as string;
    if (seen.has(dependentId)) continue;
    seen.add(dependentId);
    const dependentState = states.get(dependentId);
    if (
      descendantStates === "all" ||
      (dependentState !== undefined && descendantStates.has(dependentState))
    ) {
      targets.add(dependentId);
    }
    queue.push(...(graph.nodes[dependentId]?.dependents ?? []));
  }
  return {
    ok: true,
    nodeIds: graph.order.filter((id) => targets.has(id)),
  };
}

/**
 * The reset plan for a refresh request (pure). The target must not be
 * running or succeeded — in either mode — since a refresh exists to give
 * failed or waiting work new input. On top of planAdminReset's nodes it
 * resets every other refreshed node (the target's context input), so the
 * target receives the re-snapshotted value rather than a cached output.
 * Those inputs are only consumed by the target, so resetting a succeeded
 * input never discards work anything else depends on.
 */
export function planRefreshReset(
  graph: CompiledGraph,
  states: ReadonlyMap<string, NodeState>,
  action: AdminRequestAction,
  refresh: GraphRefresh,
  mode: "live" | "offline",
): AdminResetPlan {
  const target = refresh.targetNodeId;
  const state = states.get(target);
  if (state === "running" || state === "succeeded" || state === "cancelling") {
    return {
      ok: false,
      message: `node "${target}" is ${state}; refresh only re-runs nodes that have not succeeded and are not running`,
    };
  }
  const plan = planAdminReset(graph, states, action, target, mode);
  if (!plan.ok) return plan;
  const ids = new Set([...plan.nodeIds, ...Object.keys(refresh.configs)]);
  return { ok: true, nodeIds: graph.order.filter((id) => ids.has(id)) };
}

/**
 * Build the refresh revision for a request, or the reason it cannot apply.
 * The proposal id is derived from the request id, so a retried resolution
 * cannot record two revisions for one request.
 */
export function refreshRevisionFor(
  graph: CompiledGraph,
  request: AdminRequest,
):
  | { readonly ok: true; readonly revision: GraphRevision }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  const refresh = request.refresh;
  if (refresh === undefined) {
    return { ok: false, message: "request carries no refresh" };
  }
  if (refresh.targetNodeId !== request.nodeId) {
    return {
      ok: false,
      message: `refresh targets "${refresh.targetNodeId}" but the request targets "${request.nodeId}"`,
    };
  }
  try {
    return {
      ok: true,
      revision: buildRefreshRevision(graph, refresh, {
        id: `refresh:${request.requestId}`,
        proposer: `operator:${request.action} --refresh`,
      }),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface OfflineAdminResult {
  /** The request after the attempt (applied offline, or already resolved). */
  readonly request: AdminRequest;
  /** True when this call resolved it (applied or rejected). */
  readonly resolvedNow: boolean;
}

/**
 * Apply a pending admin request with no live coordinator (plan §16): take
 * the administrative coordinator lease — which rejects while a coordinator
 * owns the run — re-check the request is still pending, and resolve it with
 * its node_reset events in one transaction, reopening a finished run.
 * Rejects when the store does not support admin requests.
 */
export async function applyAdminRequestOffline(
  store: RunStore,
  requestId: string,
): Promise<OfflineAdminResult> {
  if (
    store.getAdminRequest === undefined ||
    store.resolveAdminRequest === undefined
  ) {
    throw new Error("this run store does not support admin requests");
  }
  const getRequest = store.getAdminRequest.bind(store);
  const resolve = store.resolveAdminRequest.bind(store);
  const initial = await getRequest(requestId);
  if (initial === undefined) {
    throw new Error(`unknown admin request: "${requestId}"`);
  }
  if (initial.status !== "pending") {
    return { request: initial, resolvedNow: false };
  }
  return withAdministrativeCoordinatorLease(
    store,
    initial.runId,
    "reset",
    async (currentLease) => {
      const request = await getRequest(requestId);
      if (request === undefined) {
        throw new Error(`unknown admin request: "${requestId}"`);
      }
      if (request.status !== "pending") {
        return { request, resolvedNow: false };
      }
      const stored = await store.getRun(request.runId);
      if (stored === undefined) {
        throw new Error(`unknown run: "${request.runId}"`);
      }
      const { states } = await replayStates(store, request.runId);
      const refreshed =
        request.refresh === undefined
          ? undefined
          : refreshRevisionFor(stored.graph, request);
      const plan =
        refreshed !== undefined && !refreshed.ok
          ? ({ ok: false, message: refreshed.message } as const)
          : request.refresh === undefined
            ? planAdminReset(
                stored.graph,
                states,
                request.action,
                request.nodeId,
                "offline",
              )
            : planRefreshReset(
                stored.graph,
                states,
                request.action,
                request.refresh,
                "offline",
              );
      const result = plan.ok
        ? await resolve(
            {
              requestId,
              status: "applied",
              resolvedBy: "offline",
              resetNodeIds: plan.nodeIds,
              events: plan.nodeIds.map((id) => ({
                kind: "node_reset" as const,
                nodeId: id,
              })),
              expectedRevision: stored.revision,
              reopen: stored.finished,
              ...(refreshed?.ok === true
                ? {
                    graphRevision: {
                      revision: refreshed.revision,
                      expectedGraphRevision: stored.graphRevision,
                    },
                  }
                : {}),
            },
            await currentLease(),
          )
        : await resolve(
            {
              requestId,
              status: "rejected",
              resolvedBy: "offline",
              message: plan.message,
            },
            await currentLease(),
          );
      return { request: result.request, resolvedNow: result.resolved };
    },
  );
}

const ADMIN_LEASE_DURATION_MS = 30_000;

async function withAdministrativeCoordinatorLease<T>(
  store: RunStore,
  runId: string,
  operation: "abort" | "reset",
  task: (currentLease: () => Promise<RunLease>) => Promise<T>,
): Promise<T> {
  let lease: RunLease;
  try {
    lease = await store.acquireCoordinatorLease(
      runId,
      `admin-${operation}-${Math.random().toString(36).slice(2)}`,
      ADMIN_LEASE_DURATION_MS,
    );
  } catch (error: unknown) {
    const leases = await store.getRunLeases(runId).catch(() => []);
    if (leases.some((candidate) => candidate.kind === "coordinator")) {
      throw new Error(
        `cannot ${operation} run "${runId}" while an active coordinator lease exists`,
        { cause: error },
      );
    }
    throw error;
  }

  let renewalTail = Promise.resolve();
  let renewalFailure: Error | undefined;
  const currentLease = (): Promise<RunLease> => {
    const renewal = renewalTail.then(async () => {
      if (renewalFailure !== undefined) throw renewalFailure;
      lease = await store.renewLease(lease, ADMIN_LEASE_DURATION_MS);
      return lease;
    });
    renewalTail = renewal.then(
      () => undefined,
      (error: unknown) => {
        renewalFailure ??=
          error instanceof Error
            ? error
            : new Error("administrative lease renewal failed", {
                cause: error,
              });
      },
    );
    return renewal;
  };
  const renewalTimer = setInterval(() => {
    void currentLease().catch(() => undefined);
  }, ADMIN_LEASE_DURATION_MS / 2);

  try {
    const result = await task(currentLease);
    await renewalTail;
    if (renewalFailure !== undefined) throw renewalFailure;
    return result;
  } finally {
    clearInterval(renewalTimer);
    await renewalTail;
    await store.releaseLease(lease);
  }
}
