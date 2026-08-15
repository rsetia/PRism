import type { CompiledGraph } from "../graph/types.js";
import {
  snapshotRunEvent,
  snapshotRunOutcome,
} from "../internal/persistence.js";
import type { PersistedRunEvent, RunEvent } from "../runtime/events.js";
import type {
  AcquireLeaseInput,
  LeaseFence,
  RunLease,
  RunStore,
  RunSummary,
  StoredRun,
} from "../runtime/ports.js";
import type { RunOutcome } from "../runtime/types.js";

interface MemoryRun {
  readonly runId: string;
  readonly graph: CompiledGraph;
  readonly events: PersistedRunEvent[];
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
  const now = options.now ?? Date.now;

  const leaseKey = (runId: string, nodeId?: string): string =>
    `${runId}\u0000${nodeId ?? ""}`;
  const assertFence = (runId: string, fence: LeaseFence | undefined): void => {
    if (fence === undefined) return;
    if (fence.runId !== runId)
      throw new Error(`lease fence targets another run: "${fence.runId}"`);
    const current = leases.get(leaseKey(runId, fence.nodeId));
    if (
      current === undefined ||
      current.owner !== fence.owner ||
      current.fencingToken !== fence.fencingToken ||
      current.expiresAtMs <= now()
    ) {
      throw new Error(`lease fencing conflict for run "${runId}"`);
    }
  };

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
    fence?: LeaseFence,
  ): Promise<readonly PersistedRunEvent[]> {
    const run = runs.get(runId);
    if (run === undefined) {
      return Promise.reject(new Error(`unknown run: "${runId}"`));
    }
    if (run.finished) {
      return Promise.reject(new Error(`run is already finished: "${runId}"`));
    }
    assertFence(runId, fence);
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
    fence?: LeaseFence,
  ): Promise<void> {
    const run = runs.get(runId);
    if (run === undefined) {
      return Promise.reject(new Error(`unknown run: "${runId}"`));
    }
    if (run.finished) {
      return Promise.resolve();
    }
    try {
      assertFence(runId, fence);
    } catch (error) {
      return Promise.reject(error);
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

  function reopenRun(runId: string, fence?: LeaseFence): Promise<void> {
    const run = runs.get(runId);
    if (run === undefined) {
      return Promise.reject(new Error(`unknown run: "${runId}"`));
    }
    try {
      assertFence(runId, fence);
    } catch (error) {
      return Promise.reject(error);
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

  function acquireLease(input: AcquireLeaseInput): Promise<RunLease> {
    if (
      !Number.isSafeInteger(input.ttlMs) ||
      input.ttlMs <= 0 ||
      input.owner.length === 0
    ) {
      return Promise.reject(
        new Error("lease owner and ttlMs must be non-empty and positive"),
      );
    }
    if (!runs.has(input.runId))
      return Promise.reject(new Error(`unknown run: "${input.runId}"`));
    const key = leaseKey(input.runId, input.nodeId);
    const current = leases.get(key);
    const at = now();
    if (
      current !== undefined &&
      current.expiresAtMs > at &&
      current.owner !== input.owner
    ) {
      return Promise.reject(
        new Error(`lease ownership conflict for run "${input.runId}"`),
      );
    }
    const lease = Object.freeze({
      runId: input.runId,
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      owner: input.owner,
      expiresAtMs: at + input.ttlMs,
      fencingToken:
        current === undefined
          ? 1
          : current.fencingToken + (current.owner === input.owner ? 0 : 1),
    });
    leases.set(key, lease);
    return Promise.resolve(lease);
  }

  function renewLease(lease: RunLease, ttlMs: number): Promise<RunLease> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      return Promise.reject(
        new Error("lease ttlMs must be a positive integer"),
      );
    try {
      assertFence(lease.runId, lease);
      const renewed = Object.freeze({ ...lease, expiresAtMs: now() + ttlMs });
      leases.set(leaseKey(lease.runId, lease.nodeId), renewed);
      return Promise.resolve(renewed);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function releaseLease(lease: RunLease): Promise<void> {
    const current = leases.get(leaseKey(lease.runId, lease.nodeId));
    if (
      current?.owner === lease.owner &&
      current.fencingToken === lease.fencingToken
    )
      leases.delete(leaseKey(lease.runId, lease.nodeId));
    return Promise.resolve();
  }

  function getLease(
    runId: string,
    nodeId?: string,
  ): Promise<RunLease | undefined> {
    const lease = leases.get(leaseKey(runId, nodeId));
    return Promise.resolve(
      lease === undefined || lease.expiresAtMs <= now() ? undefined : lease,
    );
  }

  return Object.freeze({
    createRun,
    appendEvents,
    readEvents,
    getRun,
    listRuns,
    finishRun,
    reopenRun,
    acquireLease,
    renewLease,
    releaseLease,
    getLease,
  });
}
