import { afterEach, describe, expect, test } from "vitest";
import { compileGraph, parseGraph } from "../../src/index.js";
import type {
  CompiledGraph,
  PersistedRunEvent,
  RunEvent,
  RunStore,
} from "../../src/index.js";

/**
 * The shared RunStore contract (plan §12). Every store adapter — memory
 * today, SQLite next — must pass this identical suite, so semantics
 * cannot drift between implementations. `makeStore` returns a fresh,
 * empty store per test; the suite closes it afterward.
 */
export function runStoreContract(
  label: string,
  makeStore: () => RunStore,
): void {
  describe(`RunStore contract: ${label}`, () => {
    let store: RunStore;

    function open(): RunStore {
      store = makeStore();
      return store;
    }

    afterEach(async () => {
      await store.close?.();
    });

    test("createRun then getRun exposes the run and its graph", async () => {
      const s = open();
      const graph = fixtureGraph();
      await s.createRun({ runId: "r", graph });

      const run = await s.getRun("r");
      expect(run?.runId).toBe("r");
      expect(run?.finished).toBe(false);
      expect(run?.revision).toBe(0);
      // Assert graph fields rather than deep-equality: a durable store
      // reconstructs the graph from storage, so identity won't match.
      expect(run?.graph.version).toBe(1);
      expect(run?.graph.order).toEqual(graph.order);
      expect(run?.graph.finalNode).toBe(graph.finalNode);
      expect(run?.graph.nodes["only"]?.executor).toBe("constant");
    });

    test("getRun for an unknown run resolves undefined", async () => {
      const s = open();
      expect(await s.getRun("nope")).toBeUndefined();
    });

    test("createRun rejects a duplicate runId", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      await expect(
        s.createRun({ runId: "r", graph: fixtureGraph() }),
      ).rejects.toThrow();
    });

    test("appendEvents assigns gapless seq from 0 across batches", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      const first = await s.appendEvents("r", [ready("a"), started("a")]);
      const second = await s.appendEvents("r", [ready("b")]);
      expect(first.map((e) => e.seq)).toEqual([0, 1]);
      expect(second.map((e) => e.seq)).toEqual([2]);
      expect(first[0]?.kind).toBe("node_ready");
      expect((await s.getRun("r"))?.revision).toBe(3);
    });

    test("appendEvents rejects a stale expected revision", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      await s.appendEvents("r", [ready("a")], 0);
      await expect(s.appendEvents("r", [started("a")], 0)).rejects.toThrow();

      const appended = await s.appendEvents("r", [started("a")], 1);
      expect(appended[0]?.seq).toBe(1);
    });

    test("a late subscriber sees the full history, then completes", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      await s.appendEvents("r", [ready("a"), started("a")]);
      await s.finishRun("r");
      const seen: PersistedRunEvent[] = [];
      await collect(s.readEvents("r"), seen);
      expect(seen.map((e) => e.seq)).toEqual([0, 1]);
    });

    test("fromSeq skips earlier events", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      await s.appendEvents("r", [ready("a"), started("a"), ready("b")]);
      await s.finishRun("r");
      const seen: PersistedRunEvent[] = [];
      await collect(s.readEvents("r", 1), seen);
      expect(seen.map((e) => e.seq)).toEqual([1, 2]);
    });

    test("a live subscriber receives events appended after it starts", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      const seen: PersistedRunEvent[] = [];
      const done = collect(s.readEvents("r"), seen);
      await s.appendEvents("r", [ready("a")]);
      await s.appendEvents("r", [started("a")]);
      await s.finishRun("r");
      await done;
      expect(seen.map((e) => e.seq)).toEqual([0, 1]);
    });

    test("multiple consumers each own a cursor and see everything", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      const early: PersistedRunEvent[] = [];
      const doneEarly = collect(s.readEvents("r"), early);
      await s.appendEvents("r", [ready("a")]);
      const late: PersistedRunEvent[] = [];
      const doneLate = collect(s.readEvents("r"), late);
      await s.appendEvents("r", [started("a")]);
      await s.finishRun("r");
      await Promise.all([doneEarly, doneLate]);
      expect(early.map((e) => e.seq)).toEqual([0, 1]);
      expect(late.map((e) => e.seq)).toEqual([0, 1]);
    });

    test("appendEvents rejects for an unknown run", async () => {
      const s = open();
      await expect(s.appendEvents("nope", [ready("a")])).rejects.toThrow();
    });

    test("appendEvents rejects after finishRun", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      await s.finishRun("r");
      await expect(s.appendEvents("r", [ready("a")])).rejects.toThrow();
    });

    test("readEvents for an unknown run rejects on iteration", async () => {
      const s = open();
      await expect(collect(s.readEvents("nope"), [])).rejects.toThrow();
    });

    test("finishRun is idempotent", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      await s.finishRun("r");
      await expect(s.finishRun("r")).resolves.toBeUndefined();
    });

    test("listRuns is empty for a fresh store", async () => {
      expect(await open().listRuns()).toEqual([]);
    });

    test("listRuns returns summaries, most-recent-created first", async () => {
      const s = open();
      await s.createRun({ runId: "a", graph: fixtureGraph() });
      await s.createRun({ runId: "b", graph: fixtureGraph() });
      await s.finishRun("b");

      const runs = await s.listRuns();
      expect(runs.map((run) => run.runId)).toEqual(["b", "a"]);
      expect(runs.find((run) => run.runId === "b")?.finished).toBe(true);
      expect(runs.find((run) => run.runId === "a")?.finished).toBe(false);
      expect(Object.isFrozen(runs)).toBe(true);
      expect(runs.every((run) => Object.isFrozen(run))).toBe(true);
    });

    test("listRuns returns a point-in-time snapshot", async () => {
      const s = open();
      await s.createRun({ runId: "a", graph: fixtureGraph() });
      const beforeFinish = await s.listRuns();
      await s.finishRun("a");
      await s.createRun({ runId: "b", graph: fixtureGraph() });

      expect(beforeFinish).toEqual([{ runId: "a", finished: false }]);
      expect(await s.listRuns()).toEqual([
        { runId: "b", finished: false },
        { runId: "a", finished: true },
      ]);
    });

    test("persisted events survive with their full payload", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      await s.appendEvents("r", [
        {
          kind: "node_failed",
          nodeId: "only",
          failure: {
            nodeId: "only",
            cause: { code: "X" },
            failureClass: "semantic_failed",
          },
        },
      ]);
      await s.finishRun("r");
      const seen: PersistedRunEvent[] = [];
      await collect(s.readEvents("r"), seen);
      const event = seen[0];
      expect(event?.kind).toBe("node_failed");
      if (event?.kind === "node_failed") {
        expect(event.failure.failureClass).toBe("semantic_failed");
        expect(event.failure.cause).toEqual({ code: "X" });
      }
    });
  });
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

const ready = (nodeId: string): RunEvent => ({ kind: "node_ready", nodeId });
const started = (nodeId: string): RunEvent => ({
  kind: "node_started",
  nodeId,
});

async function collect(
  iterable: AsyncIterable<PersistedRunEvent>,
  into: PersistedRunEvent[],
): Promise<void> {
  for await (const event of iterable) {
    into.push(event);
  }
}
