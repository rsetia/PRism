import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createSqliteStore,
  parseGraph,
} from "../src/index.js";
import type { CompiledGraph, PersistedRunEvent } from "../src/index.js";
import { runStoreContract } from "./support/run-store-contract.js";

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
  test("run summaries survive reopen in newest-first order", async () => {
    const path = tempDbPath();
    const store = createSqliteStore({ path });
    await store.createRun({ runId: "older", graph: fixtureGraph() });
    await store.createRun({ runId: "newer", graph: fixtureGraph() });
    await store.finishRun("older");
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
    await store.finishRun("r");
    await store.close?.();

    const reopened = createSqliteStore({ path });
    const run = await reopened.getRun("r");
    expect(run?.runId).toBe("r");
    expect(run?.finished).toBe(true);
    expect(run?.graph.finalNode).toBe("only");

    const events = await collect(reopened.readEvents("r"));
    expect(events.map((e) => e.kind)).toEqual([
      "node_ready",
      "node_started",
      "node_succeeded",
    ]);
    await reopened.close?.();
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
