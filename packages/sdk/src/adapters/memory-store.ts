import type { CompiledGraph } from "../graph/types.js";
import type { PersistedRunEvent, RunEvent } from "../runtime/events.js";
import type { RunStore, StoredRun } from "../runtime/ports.js";

interface MemoryRun {
  readonly runId: string;
  readonly graph: CompiledGraph;
  readonly events: PersistedRunEvent[];
  readonly waiters: Set<() => void>;
  finished: boolean;
}

function persistEvent(event: RunEvent, seq: number): PersistedRunEvent {
  switch (event.kind) {
    case "node_ready":
      return Object.freeze({ kind: event.kind, nodeId: event.nodeId, seq });

    case "node_started":
      return Object.freeze({ kind: event.kind, nodeId: event.nodeId, seq });

    case "node_cancelling":
      return Object.freeze({ kind: event.kind, nodeId: event.nodeId, seq });

    case "node_cancelled":
      return Object.freeze({ kind: event.kind, nodeId: event.nodeId, seq });

    case "node_succeeded":
      return Object.freeze({
        kind: event.kind,
        nodeId: event.nodeId,
        output: event.output,
        seq,
      });

    case "node_failed":
      return Object.freeze({
        kind: event.kind,
        nodeId: event.nodeId,
        failure: Object.freeze({
          nodeId: event.failure.nodeId,
          cause: event.failure.cause,
        }),
        seq,
      });

    case "node_blocked":
      return Object.freeze({
        kind: event.kind,
        nodeId: event.nodeId,
        blockedBy: Object.freeze([...event.blockedBy]),
        seq,
      });

    default: {
      const unhandledEvent: never = event;
      throw new Error(`unhandled run event: ${JSON.stringify(unhandledEvent)}`);
    }
  }
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
export function createMemoryStore(): RunStore {
  const runs = new Map<string, MemoryRun>();

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
      events: [],
      waiters: new Set(),
    });
    return Promise.resolve();
  }

  function appendEvents(
    runId: string,
    events: readonly RunEvent[],
  ): Promise<readonly PersistedRunEvent[]> {
    const run = runs.get(runId);
    if (run === undefined) {
      return Promise.reject(new Error(`unknown run: "${runId}"`));
    }
    if (run.finished) {
      return Promise.reject(new Error(`run is already finished: "${runId}"`));
    }

    const firstSequence = run.events.length;
    const persisted = events.map((event, index) =>
      persistEvent(event, firstSequence + index),
    );
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

    return Promise.resolve(
      Object.freeze({
        runId: run.runId,
        graph: run.graph,
        finished: run.finished,
      }),
    );
  }

  function finishRun(runId: string): Promise<void> {
    const run = runs.get(runId);
    if (run === undefined) {
      return Promise.reject(new Error(`unknown run: "${runId}"`));
    }
    if (run.finished) {
      return Promise.resolve();
    }

    run.finished = true;
    wakeReaders(run);
    return Promise.resolve();
  }

  return Object.freeze({
    createRun,
    appendEvents,
    readEvents,
    getRun,
    finishRun,
  });
}
