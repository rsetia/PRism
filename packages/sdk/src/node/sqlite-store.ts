import { createRequire } from "node:module";
import type { DatabaseSync as Database } from "node:sqlite";
import type { CompiledGraph } from "../graph/types.js";
import { isPlainObject } from "../internal/json.js";
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

export interface SqliteStoreOptions {
  /**
   * Database file path. Use ":memory:" for an ephemeral store (durable
   * within one instance only — a fresh instance sees nothing, so it is
   * for the contract suite, not for reopen tests).
   */
  readonly path: string;
  /** Time source used when an event is durably appended. */
  readonly now?: () => number;
}

const loadBuiltin = createRequire(import.meta.url);

function openDatabase(path: string): Database {
  const sqlite = loadBuiltin("node:sqlite") as typeof import("node:sqlite");
  return new sqlite.DatabaseSync(path, { timeout: 5_000 });
}

/**
 * Node-only durable RunStore backed by SQLite (plan §12). Same interface, same
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
 *     schema_version INTEGER NOT NULL,
 *     outcome_json TEXT
 *   )
 *   events(
 *     run_id TEXT NOT NULL,
 *     seq INTEGER NOT NULL,
 *     event_json TEXT NOT NULL,
 *     PRIMARY KEY (run_id, seq)
 *   )
 * Set `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.
 * Schema version 2 adds stable event timestamps inside event_json. Version 1
 * events remain readable with timestampMs: null, making unavailable timing
 * data explicit instead of inventing a migration time. The version stamp
 * (user_version + runs.schema_version) is applied on the first write, never
 * on open, so a read-only open cannot strand the file above what an older
 * release accepts.
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
 * - finishRun: atomically persist the outcome and set finished = 1;
 *   idempotent, with the first outcome winning.
 * - close: db.close(). After close the store must not be used.
 *
 * Reopen: constructing a new store over an existing file must expose the
 * persisted runs and events unchanged — that is what makes resume work.
 */
export function createSqliteStore(options: SqliteStoreOptions): RunStore {
  const schemaVersion = 2;
  const db = openDatabase(options.path);
  const now = options.now ?? Date.now;
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
      schema_version INTEGER NOT NULL,
      graph_revision INTEGER NOT NULL DEFAULT 0,
      outcome_json TEXT,
      CHECK (
        (finished = 0 AND outcome_json IS NULL) OR
        (finished = 1 AND outcome_json IS NOT NULL)
      )
    ) STRICT;
    CREATE TABLE IF NOT EXISTS graph_revisions (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      proposal_id TEXT NOT NULL,
      revision_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq),
      UNIQUE (run_id, proposal_id),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq >= 0),
      event_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS run_leases (
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('coordinator', 'node')),
      node_id TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY (run_id, kind, node_id),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS lease_fencing_tokens (
      token INTEGER PRIMARY KEY AUTOINCREMENT
    ) STRICT;
  `);
  let hasGraphRevision = db
    .prepare("PRAGMA table_info(runs)")
    .all()
    .some((column) => readString(column, "name") === "graph_revision");

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
  // The version stamp is deferred to the first write: opening a store for
  // reading (inspect, watch) must leave the database byte-identical so the
  // previous release can still open it after a rollback.
  let stampedVersion = storedVersion >= schemaVersion;

  let selectRun = prepareSelectRun(hasGraphRevision);

  function prepareSelectRun(includeGraphRevision: boolean) {
    return db.prepare(
      `SELECT run_id, graph_json, finished, schema_version, outcome_json, ${
        includeGraphRevision ? "graph_revision" : "0 AS graph_revision"
      },
       (SELECT COUNT(*) FROM events WHERE events.run_id = runs.run_id) AS revision
     FROM runs WHERE run_id = ?`,
    );
  }

  function ensureSchemaCurrent(): void {
    if (stampedVersion && hasGraphRevision) {
      return;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!hasGraphRevision) {
        db.exec(
          "ALTER TABLE runs ADD COLUMN graph_revision INTEGER NOT NULL DEFAULT 0",
        );
        hasGraphRevision = true;
        selectRun = prepareSelectRun(true);
      }
      db.prepare(
        "UPDATE runs SET schema_version = ? WHERE schema_version < ?",
      ).run(schemaVersion, schemaVersion);
      db.exec(`PRAGMA user_version = ${String(schemaVersion)}`);
      db.exec("COMMIT");
    } catch (error: unknown) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      throw error;
    }
    stampedVersion = true;
  }

  const insertRun = db.prepare(
    "INSERT INTO runs (run_id, graph_json, schema_version) VALUES (?, ?, ?)",
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
    "UPDATE runs SET finished = 1, outcome_json = ? WHERE run_id = ?",
  );
  const reopenRunStatement = db.prepare(
    "UPDATE runs SET finished = 0, outcome_json = NULL WHERE run_id = ?",
  );
  const selectLease = db.prepare(
    "SELECT owner, fencing_token, expires_at_ms FROM run_leases WHERE run_id = ? AND kind = ? AND node_id = ?",
  );
  const allocateFencingToken = db.prepare(
    "INSERT INTO lease_fencing_tokens DEFAULT VALUES",
  );
  const upsertLease = db.prepare(
    "INSERT INTO run_leases (run_id, kind, node_id, owner, fencing_token, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, kind, node_id) DO UPDATE SET owner = excluded.owner, fencing_token = excluded.fencing_token, expires_at_ms = excluded.expires_at_ms",
  );
  const renewLeaseStatement = db.prepare(
    "UPDATE run_leases SET expires_at_ms = ? WHERE run_id = ? AND kind = ? AND node_id = ? AND owner = ? AND fencing_token = ? AND expires_at_ms > ?",
  );
  const releaseLeaseStatement = db.prepare(
    "DELETE FROM run_leases WHERE run_id = ? AND kind = ? AND node_id = ? AND owner = ? AND fencing_token = ?",
  );
  const selectRunLeases = db.prepare(
    "SELECT kind, node_id, fencing_token, expires_at_ms FROM run_leases WHERE run_id = ? AND expires_at_ms > ? ORDER BY kind, node_id",
  );
  const selectGraphRevisions = db.prepare(
    "SELECT revision_json FROM graph_revisions WHERE run_id = ? ORDER BY seq",
  );
  const selectGraphRevisionByProposal = db.prepare(
    "SELECT revision_json FROM graph_revisions WHERE run_id = ? AND proposal_id = ?",
  );
  const insertGraphRevision = db.prepare(
    "INSERT INTO graph_revisions (run_id, seq, proposal_id, revision_json) VALUES (?, ?, ?, ?)",
  );
  const selectGraphRevisionCount = db.prepare(
    "SELECT COUNT(*) AS count FROM graph_revisions WHERE run_id = ?",
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

  function assertDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0)
      throw new Error("lease duration must be a finite number greater than 0");
  }
  function nodeKey(lease: Pick<RunLease, "nodeId">): string {
    return lease.nodeId ?? "";
  }
  function assertCurrentLease(lease: RunLease): void {
    const row = selectLease.get(lease.runId, lease.kind, nodeKey(lease));
    if (
      row === undefined ||
      readString(row, "owner") !== lease.owner ||
      readNumber(row, "fencing_token") !== lease.fencingToken ||
      readNumber(row, "expires_at_ms") <= now()
    ) {
      throw new Error(`lease fencing conflict for run: "${lease.runId}"`);
    }
  }

  function createRun(input: {
    readonly runId: string;
    readonly graph: CompiledGraph;
  }): Promise<void> {
    return capture(() => {
      assertOpen();
      ensureSchemaCurrent();
      insertRun.run(input.runId, JSON.stringify(input.graph), schemaVersion);
    });
  }

  function appendEvents(
    runId: string,
    events: readonly RunEvent[],
    expectedRevision?: number,
    lease?: RunLease,
  ): Promise<readonly PersistedRunEvent[]> {
    return capture(() => {
      assertOpen();
      ensureSchemaCurrent();
      db.exec("BEGIN IMMEDIATE");
      try {
        const run = selectRun.get(runId);
        if (run === undefined) {
          throw new Error(`unknown run: "${runId}"`);
        }
        if (readNumber(run, "finished") === 1) {
          throw new Error(`run is already finished: "${runId}"`);
        }
        if (lease !== undefined) assertCurrentLease(lease);

        const nextSequenceRow = selectNextSequence.get(runId);
        let sequence = readNumber(nextSequenceRow, "next_seq");
        if (expectedRevision !== undefined && expectedRevision !== sequence) {
          throw new Error(
            `run revision conflict: expected ${String(expectedRevision)}, actual ${String(sequence)}`,
          );
        }
        const persisted = events.map((event) => {
          const saved = snapshotRunEvent(event, sequence, now());
          insertEvent.run(runId, sequence, JSON.stringify(saved));
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
      const finished = readNumber(row, "finished") === 1;
      const outcomeJson = readNullableString(row, "outcome_json");
      const base = {
        runId: readString(row, "run_id"),
        graph: decodeGraph(readString(row, "graph_json")),
        revision: readNumber(row, "revision"),
        graphRevision: readNumber(row, "graph_revision"),
      };
      if (finished) {
        if (outcomeJson === undefined) {
          throw new Error(`finished run is missing its outcome: "${runId}"`);
        }
        return Object.freeze({
          ...base,
          finished: true,
          outcome: decodeOutcome(outcomeJson),
        });
      }
      if (outcomeJson !== undefined) {
        throw new Error(`unfinished run has a terminal outcome: "${runId}"`);
      }
      return Object.freeze({ ...base, finished: false });
    });
  }

  function finishRun(
    runId: string,
    outcome: RunOutcome,
    lease?: RunLease,
  ): Promise<void> {
    return capture(() => {
      assertOpen();
      ensureSchemaCurrent();
      const run = selectRun.get(runId);
      if (run === undefined) {
        throw new Error(`unknown run: "${runId}"`);
      }
      if (readNumber(run, "finished") === 1) {
        return;
      }
      if (lease !== undefined) assertCurrentLease(lease);
      const persistedOutcome = snapshotRunOutcome(outcome);
      finishRunStatement.run(JSON.stringify(persistedOutcome), runId);
      wakeReaders(runId);
    });
  }

  function reopenRun(runId: string, lease?: RunLease): Promise<void> {
    return capture(() => {
      assertOpen();
      ensureSchemaCurrent();
      if (lease !== undefined) assertCurrentLease(lease);
      const result = reopenRunStatement.run(runId);
      if (result.changes === 0) {
        throw new Error(`unknown run: "${runId}"`);
      }
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

  function acquire(
    kind: RunLease["kind"],
    runId: string,
    nodeId: string | undefined,
    owner: string,
    durationMs: number,
  ): Promise<RunLease> {
    return capture(() => {
      assertOpen();
      ensureSchemaCurrent();
      assertDuration(durationMs);
      if (owner.length === 0) throw new Error("lease owner must not be empty");
      if (selectRun.get(runId) === undefined)
        throw new Error(`unknown run: "${runId}"`);
      const key = nodeId ?? "";
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = selectLease.get(runId, kind, key);
        if (
          current !== undefined &&
          readNumber(current, "expires_at_ms") > now() &&
          readString(current, "owner") !== owner
        )
          throw new Error(`lease ownership conflict for run: "${runId}"`);
        const token = Number(allocateFencingToken.run().lastInsertRowid);
        const expiresAtMs = now() + durationMs;
        upsertLease.run(runId, kind, key, owner, token, expiresAtMs);
        db.exec("COMMIT");
        return Object.freeze({
          kind,
          runId,
          ...(nodeId === undefined ? {} : { nodeId }),
          owner,
          fencingToken: token,
          expiresAtMs,
        });
      } catch (error: unknown) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  function appendGraphRevision(
    runId: string,
    revision: GraphRevision,
    expectedGraphRevision: number,
  ): Promise<GraphRevision> {
    return capture(() => {
      assertOpen();
      ensureSchemaCurrent();
      db.exec("BEGIN IMMEDIATE");
      try {
        const run = selectRun.get(runId);
        if (run === undefined) throw new Error(`unknown run: "${runId}"`);
        if (readNumber(run, "finished") === 1) {
          throw new Error(`run is already finished: "${runId}"`);
        }
        const duplicate = selectGraphRevisionByProposal.get(
          runId,
          revision.proposal.id,
        );
        if (duplicate !== undefined) {
          db.exec("COMMIT");
          return decodeGraphRevision(readString(duplicate, "revision_json"));
        }
        // Older databases do not have the column until their first write.
        const current = Object.hasOwn(run, "graph_revision")
          ? readNumber(run, "graph_revision")
          : 0;
        if (current !== expectedGraphRevision) {
          throw new Error(
            `graph revision conflict: expected ${String(expectedGraphRevision)}, actual ${String(current)}`,
          );
        }
        if (
          revision.decision.status === "accepted" &&
          revision.graph === undefined
        ) {
          throw new Error("accepted graph revision is missing graph");
        }
        const count = readNumber(selectGraphRevisionCount.get(runId), "count");
        const accepted = revision.decision.status === "accepted";
        const persisted = Object.freeze({
          ...revision,
          sequence: count,
          graphRevision: accepted ? current + 1 : current,
          timestampMs: now(),
          addedNodeIds: Object.freeze([...revision.addedNodeIds]),
        });
        insertGraphRevision.run(
          runId,
          count,
          revision.proposal.id,
          JSON.stringify(persisted),
        );
        if (accepted && persisted.graph !== undefined) {
          db.prepare(
            "UPDATE runs SET graph_json = ?, graph_revision = ? WHERE run_id = ?",
          ).run(JSON.stringify(persisted.graph), current + 1, runId);
        }
        db.exec("COMMIT");
        return persisted;
      } catch (error: unknown) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
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
    return capture(() => {
      assertOpen();
      assertDuration(durationMs);
      const expiresAtMs = now() + durationMs;
      const result = renewLeaseStatement.run(
        expiresAtMs,
        lease.runId,
        lease.kind,
        nodeKey(lease),
        lease.owner,
        lease.fencingToken,
        now(),
      );
      if (result.changes !== 1)
        throw new Error(`lease fencing conflict for run: "${lease.runId}"`);
      return Object.freeze({ ...lease, expiresAtMs });
    });
  }
  function releaseLease(lease: RunLease): Promise<void> {
    return capture(() => {
      assertOpen();
      releaseLeaseStatement.run(
        lease.runId,
        lease.kind,
        nodeKey(lease),
        lease.owner,
        lease.fencingToken,
      );
    });
  }
  function getRunLeases(runId: string): Promise<readonly RunLeaseStatus[]> {
    return capture(() =>
      Object.freeze(
        selectRunLeases.all(runId, now()).map((row) =>
          Object.freeze({
            kind: readString(row, "kind") as RunLease["kind"],
            ...(readString(row, "node_id") === ""
              ? {}
              : { nodeId: readString(row, "node_id") }),
            fencingToken: readNumber(row, "fencing_token"),
            expiresAtMs: readNumber(row, "expires_at_ms"),
          }),
        ),
      ),
    );
  }
  function listGraphRevisions(
    runId: string,
  ): Promise<readonly GraphRevision[]> {
    return capture(() => {
      assertOpen();
      if (selectRun.get(runId) === undefined)
        throw new Error(`unknown run: "${runId}"`);
      return Object.freeze(
        selectGraphRevisions
          .all(runId)
          .map((row) => decodeGraphRevision(readString(row, "revision_json"))),
      );
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
    reopenRun,
    acquireCoordinatorLease,
    acquireNodeLease,
    renewLease,
    releaseLease,
    getRunLeases,
    appendGraphRevision,
    listGraphRevisions,
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

function readNullableString(
  row: Record<string, unknown> | undefined,
  column: string,
): string | undefined {
  const value = row?.[column];
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`sqlite column "${column}" is not a string`);
  }
  return value;
}

function decodeGraphRevision(json: string): GraphRevision {
  const value = JSON.parse(json) as GraphRevision;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.sequence !== "number" ||
    typeof value.graphRevision !== "number" ||
    typeof value.timestampMs !== "number" ||
    typeof value.proposal?.id !== "string" ||
    typeof value.proposal.proposer !== "string" ||
    (value.decision?.status !== "accepted" &&
      value.decision?.status !== "rejected") ||
    !Array.isArray(value.addedNodeIds)
  ) {
    throw new Error("invalid persisted graph revision");
  }
  return Object.freeze({
    ...value,
    addedNodeIds: Object.freeze([...(value.addedNodeIds as readonly string[])]),
    ...(value.graph === undefined
      ? {}
      : { graph: decodeGraph(JSON.stringify(value.graph)) }),
  });
}

function decodeGraph(json: string): CompiledGraph {
  const value = JSON.parse(json) as unknown;
  if (
    !isPlainObject(value) ||
    (value["version"] !== 1 && value["version"] !== 2) ||
    !isPlainObject(value["nodes"]) ||
    !Array.isArray(value["order"]) ||
    !value["order"].every((nodeId) => typeof nodeId === "string") ||
    typeof value["finalNode"] !== "string"
  ) {
    throw new Error("stored graph is invalid");
  }
  const nodes = Object.fromEntries(
    Object.entries(value["nodes"]).map(([nodeId, node]) => [
      nodeId,
      isPlainObject(node) && node["resources"] === undefined
        ? { ...node, resources: [] }
        : node,
    ]),
  );
  const normalized = {
    ...value,
    resources: value["resources"] ?? {},
    nodes,
  };
  deepFreeze(normalized);
  return normalized as unknown as CompiledGraph;
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
  const timestampMs = value["timestampMs"];
  if (
    timestampMs !== undefined &&
    (!Number.isSafeInteger(timestampMs) || (timestampMs as number) < 0)
  ) {
    throw new Error(
      `stored event at sequence ${String(seq)} has an invalid timestampMs`,
    );
  }
  const persisted = {
    ...value,
    seq,
    timestampMs: timestampMs === undefined ? null : (timestampMs as number),
  };
  deepFreeze(persisted);
  return persisted as unknown as PersistedRunEvent;
}

function decodeOutcome(json: string): RunOutcome {
  return snapshotRunOutcome(JSON.parse(json) as unknown);
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
