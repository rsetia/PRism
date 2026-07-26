import type { PersistedRunEvent } from "./events.js";
import { reduceNodeState } from "./transitions.js";
import type { Clock, RunStore } from "./ports.js";
import type { NodeFailure, NodeState } from "./types.js";

/**
 * A read-only snapshot of a run, rebuilt from its persisted events (plan
 * §16). This is the shared core behind the operator read commands
 * (`inspect`, and later `status`/`watch`): a durable store keeps the
 * events, this folds them back into current node states — the same replay
 * the engine's resume uses, exposed for observation.
 */

export interface NodeInspection {
  readonly nodeId: string;
  readonly state: NodeState;
}

export interface RunInspection {
  readonly runId: string;
  readonly finished: boolean;
  /** Every node in compiled order, with its current state. */
  readonly nodes: readonly NodeInspection[];
  /** Originating failures observed so far. */
  readonly failures: readonly NodeFailure[];
}

export interface WatchRunOptions {
  /** Polling time source. Required so SDK watches remain deterministic. */
  readonly clock: Clock;
  /** Delay between snapshots in milliseconds. Default 1000. */
  readonly intervalMs?: number;
  /** Interrupt an in-flight polling wait. */
  readonly signal?: AbortSignal;
}

/**
 * Rebuild a run's current state from the store, without running anything.
 * Works on finished and in-progress runs alike.
 *
 * Implementation:
 * - stored = await store.getRun(runId); reject (throw) if undefined
 *   ("unknown run").
 * - initialize every node in stored.graph.order to "pending".
 * - read a SNAPSHOT, not a live follow: take exactly stored.revision events
 *   from store.readEvents(runId) (the same bounded read resume uses) so an
 *   in-progress run doesn't block waiting for more. Fold each event through
 *   reduceNodeState for its node; collect node_failed events as failures.
 * - return { runId, finished: stored.finished, nodes (in graph order),
 *   failures }.
 * - the reducer throws on an illegal transition — a corrupt/gappy log is a
 *   real error worth surfacing, not swallowing.
 */
export function inspectRun(
  store: RunStore,
  runId: string,
): Promise<RunInspection> {
  return inspectRunSnapshot(store, runId);
}

/**
 * Poll immutable run inspections until the durable run is finished.
 * The first snapshot is immediate; subsequent reads use the Clock port.
 */
export function watchRun(
  store: RunStore,
  runId: string,
  options: WatchRunOptions,
): AsyncIterable<RunInspection> {
  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("watch intervalMs must be a finite number greater than 0");
  }
  return watchRunSnapshots(
    store,
    runId,
    options.clock,
    intervalMs,
    options.signal,
  );
}

async function* watchRunSnapshots(
  store: RunStore,
  runId: string,
  clock: Clock,
  intervalMs: number,
  signal: AbortSignal | undefined,
): AsyncIterable<RunInspection> {
  while (true) {
    const inspection = await inspectRun(store, runId);
    yield inspection;
    if (inspection.finished) {
      return;
    }
    await clock.wait(intervalMs, signal);
  }
}

async function inspectRunSnapshot(
  store: RunStore,
  runId: string,
): Promise<RunInspection> {
  const stored = await store.getRun(runId);
  if (stored === undefined) {
    throw new Error(`unknown run: "${runId}"`);
  }
  if (!Number.isSafeInteger(stored.revision) || stored.revision < 0) {
    throw new Error(
      `run "${runId}" has invalid revision ${String(stored.revision)}`,
    );
  }

  const states = new Map<string, NodeState>();
  for (const nodeId of stored.graph.order) {
    states.set(nodeId, "pending");
  }

  const failureByNode = new Map<string, NodeFailure>();
  const events = await readEventSnapshot(store, runId, stored.revision);
  for (const event of events) {
    const previous = states.get(event.nodeId);
    if (previous === undefined) {
      throw new Error(`stored event targets unknown node "${event.nodeId}"`);
    }
    states.set(event.nodeId, reduceNodeState(previous, event));
    if (event.kind === "node_failed") {
      failureByNode.set(event.nodeId, event.failure);
    } else if (event.kind === "node_reset") {
      // An administrative reset drops the node's recorded failure.
      failureByNode.delete(event.nodeId);
    }
  }
  const eventFailures = stored.graph.order.flatMap((nodeId) => {
    const failure = failureByNode.get(nodeId);
    return failure === undefined ? [] : [failure];
  });
  const failures =
    stored.outcome?.status === "failed" ||
    stored.outcome?.status === "cancelled"
      ? stored.outcome.failures
      : eventFailures;

  const nodes = stored.graph.order.map((nodeId) => {
    const state = states.get(nodeId);
    if (state === undefined) {
      throw new Error(`compiled graph order contains unknown node "${nodeId}"`);
    }
    return Object.freeze({ nodeId, state });
  });

  return Object.freeze({
    runId,
    finished: stored.finished,
    nodes: Object.freeze(nodes),
    failures: Object.freeze(failures),
  });
}

async function readEventSnapshot(
  store: RunStore,
  runId: string,
  revision: number,
): Promise<readonly PersistedRunEvent[]> {
  const iterator = store.readEvents(runId)[Symbol.asyncIterator]();
  const events: PersistedRunEvent[] = [];
  try {
    for (let sequence = 0; sequence < revision; sequence += 1) {
      const next = await iterator.next();
      if (next.done) {
        throw new Error(
          `run "${runId}" ended before event sequence ${String(sequence)}`,
        );
      }
      if (next.value.seq !== sequence) {
        throw new Error(
          `run "${runId}" expected event sequence ${String(sequence)}, received ${String(next.value.seq)}`,
        );
      }
      events.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  return Object.freeze(events);
}
