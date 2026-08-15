import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, test } from "vitest";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  parseGraph,
} from "../src/index.js";
import type {
  CompiledGraph,
  ExecutorDefinition,
  PersistedRunEvent,
} from "../src/index.js";
import { createSqliteStore } from "../src/node/index.js";
import { runStoreContract } from "../src/testing/index.js";

// The durable store must pass the exact same contract as the memory
// store, over an ephemeral database per test.
runStoreContract("createSqliteStore(:memory:)", () =>
  createSqliteStore({ path: ":memory:" }),
);

const tempDir = mkdtempSync(join(tmpdir(), "prism-sqlite-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

let dbCounter = 0;
function tempDbPath(): string {
  dbCounter += 1;
  return join(tempDir, `store-${String(dbCounter)}.db`);
}

function fixtureGraph(): CompiledGraph {
  const parsed = parseGraph({
    version: 1,
    nodes: { only: { executor: "constant", config: { value: 1 } } },
    finalNode: "only",
  });
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

async function collect(
  iterable: AsyncIterable<PersistedRunEvent>,
): Promise<PersistedRunEvent[]> {
  const out: PersistedRunEvent[] = [];
  for await (const event of iterable) {
    out.push(event);
  }
  return out;
}

describe("sqlite durability", () => {
  test("upgrades timestamp-free version 1 events without inventing times", async () => {
    const path = tempDbPath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        graph_json TEXT NOT NULL,
        finished INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
        schema_version INTEGER NOT NULL,
        outcome_json TEXT,
        CHECK (
          (finished = 0 AND outcome_json IS NULL) OR
          (finished = 1 AND outcome_json IS NOT NULL)
        )
      ) STRICT;
      CREATE TABLE events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK (seq >= 0),
        event_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      ) STRICT;
    `);
    legacy
      .prepare(
        "INSERT INTO runs (run_id, graph_json, schema_version) VALUES (?, ?, 1)",
      )
      .run("legacy", JSON.stringify(fixtureGraph()));
    legacy
      .prepare("INSERT INTO events (run_id, seq, event_json) VALUES (?, 0, ?)")
      .run(
        "legacy",
        JSON.stringify({ kind: "node_ready", nodeId: "only", seq: 0 }),
      );
    legacy.close();

    const store = createSqliteStore({ path, now: () => 123 });
    const reader = store.readEvents("legacy")[Symbol.asyncIterator]();
    const before = await reader.next();
    await reader.return?.();
    if (before.done) throw new Error("legacy event was not read");
    const legacyEvent: PersistedRunEvent = before.value;
    expect(legacyEvent.timestampMs).toBeNull();

    const appended = await store.appendEvents("legacy", [
      { kind: "node_started", nodeId: "only" },
    ]);
    expect(appended[0]?.timestampMs).toBe(123);
    await store.close?.();

    // The append above is a write, so only now is the file stamped as
    // version 3 (which includes the backwards-compatible lease table).
    const stamped = new DatabaseSync(path);
    expect(stamped.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 3,
    });
    stamped.close();
  });

  test("a read-only open leaves a version 1 database untouched", async () => {
    const path = tempDbPath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        graph_json TEXT NOT NULL,
        finished INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
        schema_version INTEGER NOT NULL,
        outcome_json TEXT,
        CHECK (
          (finished = 0 AND outcome_json IS NULL) OR
          (finished = 1 AND outcome_json IS NOT NULL)
        )
      ) STRICT;
      CREATE TABLE events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK (seq >= 0),
        event_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      ) STRICT;
    `);
    legacy
      .prepare(
        "INSERT INTO runs (run_id, graph_json, schema_version) VALUES (?, ?, 1)",
      )
      .run("legacy", JSON.stringify(fixtureGraph()));
    legacy.close();

    const store = createSqliteStore({ path });
    expect(await store.listRuns()).toEqual([
      { runId: "legacy", finished: false },
    ]);
    await store.getRun("legacy");
    await store.close?.();

    // A rollback to the version 1 release must still open this file.
    const untouched = new DatabaseSync(path);
    expect(untouched.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 1,
    });
    expect(untouched.prepare("SELECT schema_version FROM runs").get()).toEqual({
      schema_version: 1,
    });
    untouched.close();
  });

  test("run summaries survive reopen in newest-first order", async () => {
    const path = tempDbPath();
    const store = createSqliteStore({ path });
    await store.createRun({ runId: "older", graph: fixtureGraph() });
    await store.createRun({ runId: "newer", graph: fixtureGraph() });
    await store.finishRun("older", {
      status: "cancelled",
      reason: null,
      failures: [],
    });
    await store.close?.();

    const reopened = createSqliteStore({ path });
    expect(await reopened.listRuns()).toEqual([
      { runId: "newer", finished: false },
      { runId: "older", finished: true },
    ]);
    await reopened.close?.();
  });

  test("a run and its events survive close and reopen", async () => {
    const path = tempDbPath();
    const store = createSqliteStore({ path });
    await store.createRun({ runId: "r", graph: fixtureGraph() });
    await store.appendEvents("r", [
      { kind: "node_ready", nodeId: "only" },
      { kind: "node_started", nodeId: "only" },
      { kind: "node_succeeded", nodeId: "only", output: 1 },
    ]);
    await store.finishRun("r", { status: "succeeded", output: 1 });
    await store.close?.();

    const reopened = createSqliteStore({ path });
    const run = await reopened.getRun("r");
    expect(run?.runId).toBe("r");
    expect(run?.finished).toBe(true);
    expect(run?.graph.finalNode).toBe("only");
    expect(run?.outcome).toEqual({ status: "succeeded", output: 1 });

    const events = await collect(reopened.readEvents("r"));
    expect(events.map((e) => e.kind)).toEqual([
      "node_ready",
      "node_started",
      "node_succeeded",
    ]);
    await reopened.close?.();
  });

  test("invalid executor output becomes a durable failure", async () => {
    const invalid: ExecutorDefinition = {
      name: "invalid",
      execute() {
        return { status: "succeeded", output: BigInt(1) } as never;
      },
    };
    const parsed = parseGraph({
      version: 1,
      nodes: { only: { executor: "invalid" } },
      finalNode: "only",
    });
    if (!parsed.ok) throw new Error("fixture parse failed");
    const compiled = compileGraph(parsed.graph);
    if (!compiled.ok) throw new Error("fixture compile failed");

    const store = createSqliteStore({ path: ":memory:" });
    const engine = createEngine({
      store,
      registry: createExecutorRegistry([invalid]),
    });
    const outcome = await engine.run(compiled.graph, { runId: "invalid" })
      .result;
    expect(outcome).toEqual({
      status: "failed",
      failures: [
        {
          nodeId: "only",
          cause: {
            code: "INVALID_EXECUTOR_OUTPUT",
            message: "executor output must be JSON-safe",
          },
          failureClass: "validation_failed",
        },
      ],
    });
    expect(await store.getRun("invalid")).toMatchObject({
      finished: true,
      outcome,
    });
    await store.close?.();
  });

  test("an unfinished run reopens with its partial history and can be appended", async () => {
    const path = tempDbPath();
    const store = createSqliteStore({ path });
    await store.createRun({ runId: "r", graph: fixtureGraph() });
    await store.appendEvents("r", [{ kind: "node_ready", nodeId: "only" }]);
    await store.close?.();

    const reopened = createSqliteStore({ path });
    const run = await reopened.getRun("r");
    expect(run?.finished).toBe(false);
    // Sequence numbering continues across the reopen — no gap, no reset.
    const appended = await reopened.appendEvents("r", [
      { kind: "node_started", nodeId: "only" },
    ]);
    expect(appended[0]?.seq).toBe(1);
    await reopened.close?.();
  });

  test("resume reclassifies a node running at the crash boundary", async () => {
    const path = tempDbPath();
    const store = createSqliteStore({ path });
    await store.createRun({ runId: "r", graph: fixtureGraph() });
    await store.appendEvents("r", [
      { kind: "node_ready", nodeId: "only" },
      { kind: "node_started", nodeId: "only" },
    ]);
    await store.close?.();

    const reopened = createSqliteStore({ path });
    const engine = createEngine({
      store: reopened,
      registry: createExecutorRegistry(builtinExecutors),
    });
    const outcome = await engine.resume("r").result;
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failures[0]?.failureClass).toBe("transient_infra");
      expect(outcome.failures[0]?.cause).toEqual({ code: "INTERRUPTED" });
    }
    await reopened.close?.();
  });

  test("resume keeps a committed completion when finishRun had not committed", async () => {
    const path = tempDbPath();
    const store = createSqliteStore({ path });
    await store.createRun({ runId: "r", graph: fixtureGraph() });
    await store.appendEvents("r", [
      { kind: "node_ready", nodeId: "only" },
      { kind: "node_started", nodeId: "only" },
      { kind: "node_succeeded", nodeId: "only", output: 1 },
    ]);
    await store.close?.();

    const reopened = createSqliteStore({ path });
    const engine = createEngine({
      store: reopened,
      registry: createExecutorRegistry(builtinExecutors),
    });
    await expect(engine.resume("r").result).resolves.toEqual({
      status: "succeeded",
      output: 1,
    });
    expect((await reopened.getRun("r"))?.finished).toBe(true);
    await reopened.close?.();
  });
});
