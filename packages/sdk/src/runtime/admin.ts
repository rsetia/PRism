import type { RunEvent } from "./events.js";
import type { RunLease, RunStore } from "./ports.js";
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
