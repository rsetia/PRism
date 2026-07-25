import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import type { CompiledGraph } from "../graph/types.js";
import { isPlainObject } from "../internal/json.js";
import type { PersistedRunEvent, RunEvent } from "../runtime/events.js";
import type { RunStore, RunSummary, StoredRun } from "../runtime/ports.js";

export interface SqliteStoreOptions {
  /**
   * Database file path. Use ":memory:" for an ephemeral store (durable
   * within one instance only — a fresh instance sees nothing, so it is
   * for the contract suite, not for reopen tests).
   */
  readonly path: string;
}

const loadBuiltin = createRequire(import.meta.url);

function openDatabase(path: string): Database {
  const sqlite = loadBuiltin("node:sqlite") as typeof import("node:sqlite");
  return new sqlite.DatabaseSync(path, { timeout: 5_000 });
}

/**
 * Durable RunStore backed by SQLite (plan §12). Same interface, same
 * contract as the memory store — only the storage is durable. The driver
 * decision is recorded in adr/0001.
 *
 * Driver: `DatabaseSync` from `node:sqlite` (see the ADR), loaded lazily
 * so consumers that only use the memory adapter do not initialize SQLite.
 * The API is synchronous — wrap results in resolved promises to satisfy
 * the async RunStore interface, exactly as the memory store already does.
 *
 * Schema (create if not exists, so a fresh instance over an existing
 * file just continues):
 *   runs(
 *     run_id TEXT PRIMARY KEY,
 *     graph_json TEXT NOT NULL,
 *     finished INTEGER NOT NULL DEFAULT 0,
 *     schema_version INTEGER NOT NULL
 *   )
 *   events(
 *     run_id TEXT NOT NULL,
 *     seq INTEGER NOT NULL,
 *     event_json TEXT NOT NULL,
 *     PRIMARY KEY (run_id, seq)
 *   )
 * Set `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.
 * Store a `schema_version` and refuse to open a newer one — migrations
 * are forward-only.
 *
 * Behavior parity with the memory store:
 * - createRun: INSERT the run; a duplicate run_id violates the primary
 *   key -> reject. Persist the graph as JSON.
 * - appendEvents: in ONE transaction, read the current max(seq) for the
 *   run, assign seq = max+1.. gaplessly, INSERT each event, commit. The
 *   transaction is the atomicity guarantee resume depends on — a crash
 *   leaves either all of a batch or none. Reject an unknown or finished
 *   run.
 * - readEvents: a cursor over persisted rows from `fromSeq`. For LIVE
 *   following, reuse the memory store's in-process waiter pattern: this
 *   store instance mediates every append in this process, so it can wake
 *   followers itself; complete the iterator when the run is finished and
 *   the cursor has drained. (Cross-process follow is out of scope — ADR.)
 * - getRun: SELECT and rebuild StoredRun (parse graph_json).
 * - finishRun: UPDATE finished = 1; idempotent.
 * - close: db.close(). After close the store must not be used.
 *
 * Reopen: constructing a new store over an existing file must expose the
 * persisted runs and events unchanged — that is what makes resume work.
 */
export function createSqliteStore(options: SqliteStoreOptions): RunStore {
  const schemaVersion = 1;
  const db = openDatabase(options.path);
  let closed = false;
  const waiters = new Map<string, Set<() => void>>();

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const versionRow = db.prepare("PRAGMA user_version").get();
  const storedVersion = readNumber(versionRow, "user_version");
  if (storedVersion > schemaVersion) {
    db.close();
    throw new Error(
      `database schema version ${String(storedVersion)} is newer than supported version ${String(schemaVersion)}`,
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      graph_json TEXT NOT NULL,
      finished INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
      schema_version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq >= 0),
      event_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    ) STRICT;
  `);

  const newestRun = db
    .prepare("SELECT MAX(schema_version) AS schema_version FROM runs")
    .get();
  const newestRunVersion = readNullableNumber(newestRun, "schema_version");
  if (newestRunVersion !== undefined && newestRunVersion > schemaVersion) {
    db.close();
    throw new Error(
      `run schema version ${String(newestRunVersion)} is newer than supported version ${String(schemaVersion)}`,
    );
  }
  if (storedVersion < schemaVersion) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "UPDATE runs SET schema_version = ? WHERE schema_version < ?",
      ).run(schemaVersion, schemaVersion);
      db.exec(`PRAGMA user_version = ${String(schemaVersion)}`);
      db.exec("COMMIT");
    } catch (error: unknown) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      db.close();
      throw error;
    }
  }

  const insertRun = db.prepare(
    "INSERT INTO runs (run_id, graph_json, schema_version) VALUES (?, ?, ?)",
  );
  const selectRun = db.prepare(
    `SELECT run_id, graph_json, finished, schema_version,
       (SELECT COUNT(*) FROM events WHERE events.run_id = runs.run_id) AS revision
     FROM runs WHERE run_id = ?`,
  );
  const selectRuns = db.prepare(
    "SELECT run_id, finished FROM runs ORDER BY rowid DESC",
  );
  const selectNextSequence = db.prepare(
    "SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq FROM events WHERE run_id = ?",
  );
  const insertEvent = db.prepare(
    "INSERT INTO events (run_id, seq, event_json) VALUES (?, ?, ?)",
  );
  const selectEvents = db.prepare(
    "SELECT seq, event_json FROM events WHERE run_id = ? AND seq >= ? ORDER BY seq",
  );
  const finishRunStatement = db.prepare(
    "UPDATE runs SET finished = 1 WHERE run_id = ?",
  );

  function assertOpen(): void {
    if (closed) {
      throw new Error("sqlite store is closed");
    }
  }

  function capture<T>(operation: () => T): Promise<T> {
    try {
      return Promise.resolve(operation());
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("sqlite operation failed", { cause: error }),
      );
    }
  }

  function wakeReaders(runId: string): void {
    const readers = waiters.get(runId);
    if (readers === undefined) {
      return;
    }
    waiters.delete(runId);
    for (const resolve of readers) {
      resolve();
    }
  }

  function createRun(input: {
    readonly runId: string;
    readonly graph: CompiledGraph;
  }): Promise<void> {
    return capture(() => {
      assertOpen();
      insertRun.run(input.runId, JSON.stringify(input.graph), schemaVersion);
    });
  }

  function appendEvents(
    runId: string,
    events: readonly RunEvent[],
    expectedRevision?: number,
  ): Promise<readonly PersistedRunEvent[]> {
    return capture(() => {
      assertOpen();
      db.exec("BEGIN IMMEDIATE");
      try {
        const run = selectRun.get(runId);
        if (run === undefined) {
          throw new Error(`unknown run: "${runId}"`);
        }
        if (readNumber(run, "finished") === 1) {
          throw new Error(`run is already finished: "${runId}"`);
        }

        const nextSequenceRow = selectNextSequence.get(runId);
        let sequence = readNumber(nextSequenceRow, "next_seq");
        if (expectedRevision !== undefined && expectedRevision !== sequence) {
          throw new Error(
            `run revision conflict: expected ${String(expectedRevision)}, actual ${String(sequence)}`,
          );
        }
        const persisted = events.map((event) => {
          const saved = Object.freeze({ ...event, seq: sequence });
          insertEvent.run(runId, sequence, JSON.stringify(event));
          sequence += 1;
          return saved;
        });
        db.exec("COMMIT");
        if (persisted.length > 0) {
          wakeReaders(runId);
        }
        return Object.freeze(persisted);
      } catch (error: unknown) {
        if (db.isTransaction) {
          db.exec("ROLLBACK");
        }
        throw error;
      }
    });
  }

  function readEvents(
    runId: string,
    fromSeq = 0,
  ): AsyncIterable<PersistedRunEvent> {
    return (async function* readPersistedEvents() {
      if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
        throw new Error(`invalid event sequence: ${String(fromSeq)}`);
      }

      let cursor = fromSeq;
      while (true) {
        assertOpen();
        const run = selectRun.get(runId);
        if (run === undefined) {
          throw new Error(`unknown run: "${runId}"`);
        }

        const rows = selectEvents.all(runId, cursor);
        for (const row of rows) {
          const sequence = readNumber(row, "seq");
          if (sequence !== cursor) {
            throw new Error(`missing event sequence ${String(cursor)}`);
          }
          cursor += 1;
          yield decodeEvent(readString(row, "event_json"), sequence);
        }

        // Yielding hands control to the consumer, so more events or the
        // finished flag may have committed while this batch was consumed.
        // Start a fresh read before deciding whether to park the cursor.
        if (rows.length > 0) {
          continue;
        }

        if (readNumber(run, "finished") === 1) {
          return;
        }

        await new Promise<void>((resolve) => {
          const readers = waiters.get(runId) ?? new Set<() => void>();
          readers.add(resolve);
          waiters.set(runId, readers);
        });
      }
    })();
  }

  function getRun(runId: string): Promise<StoredRun | undefined> {
    return capture(() => {
      assertOpen();
      const row = selectRun.get(runId);
      if (row === undefined) {
        return undefined;
      }
      return Object.freeze({
        runId: readString(row, "run_id"),
        graph: decodeGraph(readString(row, "graph_json")),
        finished: readNumber(row, "finished") === 1,
        revision: readNumber(row, "revision"),
      });
    });
  }

  function finishRun(runId: string): Promise<void> {
    return capture(() => {
      assertOpen();
      const result = finishRunStatement.run(runId);
      if (result.changes === 0) {
        throw new Error(`unknown run: "${runId}"`);
      }
      wakeReaders(runId);
    });
  }

  function listRuns(): Promise<readonly RunSummary[]> {
    return capture(() => {
      assertOpen();
      const summaries = selectRuns.all().map((row) =>
        Object.freeze({
          runId: readString(row, "run_id"),
          finished: readNumber(row, "finished") === 1,
        }),
      );
      return Object.freeze(summaries);
    });
  }

  function close(): Promise<void> {
    return capture(() => {
      if (closed) {
        return;
      }
      db.close();
      closed = true;
      for (const runId of waiters.keys()) {
        wakeReaders(runId);
      }
    });
  }

  return Object.freeze({
    createRun,
    appendEvents,
    readEvents,
    getRun,
    listRuns,
    finishRun,
    close,
  });
}

function readString(
  row: Record<string, unknown> | undefined,
  column: string,
): string {
  const value = row?.[column];
  if (typeof value !== "string") {
    throw new Error(`sqlite column "${column}" is not a string`);
  }
  return value;
}

function readNumber(
  row: Record<string, unknown> | undefined,
  column: string,
): number {
  const value = row?.[column];
  if (typeof value !== "number") {
    throw new Error(`sqlite column "${column}" is not a number`);
  }
  return value;
}

function readNullableNumber(
  row: Record<string, unknown> | undefined,
  column: string,
): number | undefined {
  const value = row?.[column];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new Error(`sqlite column "${column}" is not a number`);
  }
  return value;
}

function decodeGraph(json: string): CompiledGraph {
  const value = JSON.parse(json) as unknown;
  if (
    !isPlainObject(value) ||
    value["version"] !== 1 ||
    !isPlainObject(value["nodes"]) ||
    !Array.isArray(value["order"]) ||
    !value["order"].every((nodeId) => typeof nodeId === "string") ||
    typeof value["finalNode"] !== "string"
  ) {
    throw new Error("stored graph is invalid");
  }
  deepFreeze(value);
  return value as unknown as CompiledGraph;
}

function decodeEvent(json: string, seq: number): PersistedRunEvent {
  const value = JSON.parse(json) as unknown;
  if (
    !isPlainObject(value) ||
    typeof value["kind"] !== "string" ||
    typeof value["nodeId"] !== "string"
  ) {
    throw new Error(`stored event at sequence ${String(seq)} is invalid`);
  }
  const persisted = { ...value, seq };
  deepFreeze(persisted);
  return persisted as unknown as PersistedRunEvent;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  Object.freeze(value);
}
