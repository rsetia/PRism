import type { CompiledGraph } from "../graph/types.js";
import {
  snapshotRunEvent,
  snapshotRunOutcome,
} from "../internal/persistence.js";
import type { PersistedRunEvent, RunEvent } from "../runtime/events.js";
import type {
  RunLease,
  RunLeaseStatus,
  RunStore,
  RunSummary,
  StoredRun,
} from "../runtime/ports.js";
import type { RunOutcome } from "../runtime/types.js";
import type { GraphRevision } from "../runtime/graph-revision.js";

interface MemoryRun {
  readonly runId: string;
  readonly events: PersistedRunEvent[];
  readonly graphRevisions: GraphRevision[];
  graphRevision: number;
  graph: CompiledGraph;
  readonly waiters: Set<() => void>;
  finished: boolean;
  outcome: RunOutcome | undefined;
}

function wakeReaders(run: MemoryRun): void {
  const waiters = [...run.waiters];
  run.waiters.clear();
  for (const resolve of waiters) {
    resolve();
  }
}

function asError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

/**
 * In-memory RunStore — enough persistence to execute runs today, and
 * the same interface the durable store implements later.
 *
 * Implementation notes:
 * - One Map<runId, { graph, finished, events, waiters }>.
 * - appendEvents: seq = current length + index; push all; then resolve
 *   and clear any waiters (notify, never wait — the engine must not
 *   block on consumers).
 * - readEvents: an async generator per call (its own cursor). Yield
 *   whatever is already in the log from the cursor; when caught up,
 *   if finished -> return; otherwise await a promise that the next
 *   append or finishRun resolves, then loop.
 * - finishRun: mark finished and wake waiters so draining iterators
 *   can complete. Idempotent.
 */
export interface MemoryStoreOptions {
  /** Time source used when an event is durably appended. */
  readonly now?: () => number;
}

export function createMemoryStore(options: MemoryStoreOptions = {}): RunStore {
  const runs = new Map<string, MemoryRun>();
  const leases = new Map<string, RunLease>();
  let nextFencingToken = 1;
  const now = options.now ?? Date.now;

  function leaseKey(
    lease: Pick<RunLease, "kind" | "runId" | "nodeId">,
  ): string {
    return `${lease.runId}\u0000${lease.kind}\u0000${lease.nodeId ?? ""}`;
  }

  function duration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error("lease duration must be a finite number greater than 0");
    }
  }

  function assertCurrentLease(lease: RunLease): void {
    const current = leases.get(leaseKey(lease));
    if (
      current === undefined ||
      current.fencingToken !== lease.fencingToken ||
      current.owner !== lease.owner ||
      current.expiresAtMs <= now()
    ) {
      throw new Error(`lease fencing conflict for run: "${lease.runId}"`);
    }
  }

  function acquire(
    kind: RunLease["kind"],
    runId: string,
    nodeId: string | undefined,
    owner: string,
    durationMs: number,
  ): Promise<RunLease> {
    try {
      duration(durationMs);
      if (runs.get(runId) === undefined)
        throw new Error(`unknown run: "${runId}"`);
      if (owner.length === 0) throw new Error("lease owner must not be empty");
      const key = leaseKey({
        kind,
        runId,
        ...(nodeId === undefined ? {} : { nodeId }),
      });
      const current = leases.get(key);
      if (
        current !== undefined &&
        current.expiresAtMs > now() &&
        current.owner !== owner
      ) {
        throw new Error(`lease ownership conflict for run: "${runId}"`);
      }
      const lease = Object.freeze({
        kind,
        runId,
        ...(nodeId === undefined ? {} : { nodeId }),
        owner,
        fencingToken: nextFencingToken++,
        expiresAtMs: now() + durationMs,
      });
      leases.set(key, lease);
      return Promise.resolve(lease);
    } catch (error: unknown) {
      return Promise.reject(asError(error, "lease acquisition failed"));
    }
  }

  function createRun(input: {
    readonly runId: string;
    readonly graph: CompiledGraph;
  }): Promise<void> {
    if (runs.has(input.runId)) {
      return Promise.reject(new Error(`run already exists: "${input.runId}"`));
    }

    runs.set(input.runId, {
      runId: input.runId,
      graph: input.graph,
      graphRevision: 0,
      graphRevisions: [],
      finished: false,
      outcome: undefined,
      events: [],
      waiters: new Set(),
    });
    return Promise.resolve();
  }

  function appendEvents(
    runId: string,
    events: readonly RunEvent[],
    expectedRevision?: number,
    lease?: RunLease,
  ): Promise<readonly PersistedRunEvent[]> {
    const run = runs.get(runId);
    if (run === undefined) {
      return Promise.reject(new Error(`unknown run: "${runId}"`));
    }
    if (run.finished) {
      return Promise.reject(new Error(`run is already finished: "${runId}"`));
    }
    if (lease !== undefined) {
      try {
        assertCurrentLease(lease);
      } catch (error: unknown) {
        return Promise.reject(asError(error, "lease fencing failed"));
      }
    }
    if (
      expectedRevision !== undefined &&
      expectedRevision !== run.events.length
    ) {
      return Promise.reject(
        new Error(
          `run revision conflict: expected ${String(expectedRevision)}, actual ${String(run.events.length)}`,
        ),
      );
    }

    const firstSequence = run.events.length;
    let persisted: readonly PersistedRunEvent[];
    try {
      persisted = events.map((event, index) =>
        snapshotRunEvent(event, firstSequence + index, now()),
      );
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("event persistence failed", { cause: error }),
      );
    }
    run.events.push(...persisted);
    if (persisted.length > 0) {
      wakeReaders(run);
    }
    return Promise.resolve(Object.freeze(persisted));
  }

  function readEvents(
    runId: string,
    fromSeq = 0,
  ): AsyncIterable<PersistedRunEvent> {
    return (async function* readPersistedEvents() {
      if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
        throw new Error(`invalid event sequence: ${String(fromSeq)}`);
      }

      const run = runs.get(runId);
      if (run === undefined) {
        throw new Error(`unknown run: "${runId}"`);
      }

      let cursor = fromSeq;
      while (true) {
        while (cursor < run.events.length) {
          const event = run.events[cursor];
          if (event === undefined) {
            throw new Error(`missing event sequence ${String(cursor)}`);
          }
          cursor += 1;
          yield event;
        }

        if (run.finished) {
          return;
        }

        await new Promise<void>((resolve) => {
          run.waiters.add(resolve);
        });
      }
    })();
  }

  function getRun(runId: string): Promise<StoredRun | undefined> {
    const run = runs.get(runId);
    if (run === undefined) {
      return Promise.resolve(undefined);
    }

    const base = {
      runId: run.runId,
      graph: run.graph,
      revision: run.events.length,
      graphRevision: run.graphRevision,
    };
    if (run.finished) {
      if (run.outcome === undefined) {
        return Promise.reject(
          new Error(`finished run is missing its outcome: "${runId}"`),
        );
      }
      return Promise.resolve(
        Object.freeze({ ...base, finished: true, outcome: run.outcome }),
      );
    }
    if (run.outcome !== undefined) {
      return Promise.reject(
        new Error(`unfinished run has a terminal outcome: "${runId}"`),
      );
    }
    return Promise.resolve(Object.freeze({ ...base, finished: false }));
  }

  function finishRun(
    runId: string,
    outcome: RunOutcome,
    lease?: RunLease,
  ): Promise<void> {
    const run = runs.get(runId);
    if (run === undefined) {
      return Promise.reject(new Error(`unknown run: "${runId}"`));
    }
    if (run.finished) {
      return Promise.resolve();
    }
    if (lease !== undefined) {
      try {
        assertCurrentLease(lease);
      } catch (error: unknown) {
        return Promise.reject(asError(error, "lease fencing failed"));
      }
    }

    try {
      run.outcome = snapshotRunOutcome(outcome);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("outcome persistence failed", { cause: error }),
      );
    }
    run.finished = true;
    wakeReaders(run);
    return Promise.resolve();
  }

  function reopenRun(runId: string, lease?: RunLease): Promise<void> {
    const run = runs.get(runId);
    if (run === undefined) {
      return Promise.reject(new Error(`unknown run: "${runId}"`));
    }
    if (lease !== undefined) {
      try {
        assertCurrentLease(lease);
      } catch (error: unknown) {
        return Promise.reject(asError(error, "lease fencing failed"));
      }
    }
    run.finished = false;
    run.outcome = undefined;
    return Promise.resolve();
  }

  function listRuns(): Promise<readonly RunSummary[]> {
    const summaries = [...runs.values()]
      .reverse()
      .map((run) =>
        Object.freeze({ runId: run.runId, finished: run.finished }),
      );
    return Promise.resolve(Object.freeze(summaries));
  }

  function acquireCoordinatorLease(
    runId: string,
    owner: string,
    durationMs: number,
  ): Promise<RunLease> {
    return acquire("coordinator", runId, undefined, owner, durationMs);
  }
  function acquireNodeLease(
    runId: string,
    nodeId: string,
    owner: string,
    durationMs: number,
  ): Promise<RunLease> {
    return acquire("node", runId, nodeId, owner, durationMs);
  }
  function renewLease(lease: RunLease, durationMs: number): Promise<RunLease> {
    try {
      duration(durationMs);
      assertCurrentLease(lease);
      const renewed = Object.freeze({
        ...lease,
        expiresAtMs: now() + durationMs,
      });
      leases.set(leaseKey(lease), renewed);
      return Promise.resolve(renewed);
    } catch (error: unknown) {
      return Promise.reject(asError(error, "lease renewal failed"));
    }
  }
  function releaseLease(lease: RunLease): Promise<void> {
    const current = leases.get(leaseKey(lease));
    if (
      current?.fencingToken === lease.fencingToken &&
      current.owner === lease.owner
    )
      leases.delete(leaseKey(lease));
    return Promise.resolve();
  }
  function getRunLeases(runId: string): Promise<readonly RunLeaseStatus[]> {
    const current = [...leases.values()]
      .filter((lease) => lease.runId === runId && lease.expiresAtMs > now())
      .map(({ kind, nodeId, fencingToken, expiresAtMs }) =>
        Object.freeze({
          kind,
          ...(nodeId === undefined ? {} : { nodeId }),
          fencingToken,
          expiresAtMs,
        }),
      );
    return Promise.resolve(Object.freeze(current));
  }

  function appendGraphRevision(
    runId: string,
    revision: GraphRevision,
    expectedGraphRevision: number,
  ): Promise<GraphRevision> {
    const run = runs.get(runId);
    if (run === undefined)
      return Promise.reject(new Error(`unknown run: "${runId}"`));
    const duplicate = run.graphRevisions.find(
      (entry) => entry.proposal.id === revision.proposal.id,
    );
    if (duplicate !== undefined) return Promise.resolve(duplicate);
    if (expectedGraphRevision !== run.graphRevision) {
      return Promise.reject(
        new Error(
          `graph revision conflict: expected ${String(expectedGraphRevision)}, actual ${String(run.graphRevision)}`,
        ),
      );
    }
    if (
      revision.decision.status === "accepted" &&
      revision.graph === undefined
    ) {
      return Promise.reject(
        new Error("accepted graph revision is missing graph"),
      );
    }
    const accepted = revision.decision.status === "accepted";
    const persisted = Object.freeze({
      ...revision,
      sequence: run.graphRevisions.length,
      graphRevision: accepted ? run.graphRevision + 1 : run.graphRevision,
      timestampMs: now(),
      addedNodeIds: Object.freeze([...revision.addedNodeIds]),
    });
    run.graphRevisions.push(persisted);
    if (accepted && persisted.graph !== undefined) {
      run.graph = persisted.graph;
      run.graphRevision += 1;
    }
    return Promise.resolve(persisted);
  }

  function listGraphRevisions(
    runId: string,
  ): Promise<readonly GraphRevision[]> {
    const run = runs.get(runId);
    if (run === undefined)
      return Promise.reject(new Error(`unknown run: "${runId}"`));
    return Promise.resolve(Object.freeze([...run.graphRevisions]));
  }

  return Object.freeze({
    createRun,
    appendEvents,
    readEvents,
    getRun,
    listRuns,
    finishRun,
    reopenRun,
    acquireCoordinatorLease,
    acquireNodeLease,
    renewLease,
    releaseLease,
    getRunLeases,
    appendGraphRevision,
    listGraphRevisions,
  });
}
