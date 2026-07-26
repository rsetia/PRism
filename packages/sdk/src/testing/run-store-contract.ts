import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { compileGraph } from "../graph/compile.js";
import { parseGraph } from "../graph/parse.js";
import type { CompiledGraph, JsonValue } from "../graph/types.js";
import type { PersistedRunEvent, RunEvent } from "../runtime/events.js";
import type { RunStore } from "../runtime/ports.js";

/**
 * Creates a fresh, empty store for one contract test. Asynchronous factories
 * are supported so adapters can establish connections or reset remote state.
 */
export type RunStoreFactory = () => RunStore | Promise<RunStore>;

/**
 * Registers Prism's RunStore conformance suite with Vitest.
 *
 * Call this at module scope in a test file. Every store adapter should pass
 * this identical suite so persistence semantics cannot drift between
 * implementations. `makeStore` is called before each test, and the returned
 * store is closed afterward when it exposes `close`.
 */
export function runStoreContract(
  label: string,
  makeStore: RunStoreFactory,
): void {
  describe(`RunStore contract: ${label}`, () => {
    let store: RunStore | undefined;

    beforeEach(async () => {
      store = await makeStore();
    });

    function open(): RunStore {
      if (store === undefined) {
        throw new Error("RunStore factory did not complete");
      }
      return store;
    }

    afterEach(async () => {
      const opened = store;
      store = undefined;
      await opened?.close?.();
    });

    test("createRun then getRun exposes the run and its graph", async () => {
      const s = open();
      const graph = fixtureGraph();
      await s.createRun({ runId: "r", graph });

      const run = await s.getRun("r");
      expect(run?.runId).toBe("r");
      expect(run?.finished).toBe(false);
      expect(run).not.toHaveProperty("outcome");
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

    test("only one concurrent append can claim an expected revision", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });

      const attempts = await Promise.allSettled([
        s.appendEvents("r", [ready("a")], 0),
        s.appendEvents("r", [ready("b")], 0),
      ]);

      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts.filter((attempt) => attempt.status === "rejected"),
      ).toHaveLength(1);
      expect((await s.getRun("r"))?.revision).toBe(1);
    });

    test("a late subscriber sees the full history, then completes", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      await s.appendEvents("r", [ready("a"), started("a")]);
      await s.finishRun("r", cancelledOutcome());
      const seen: PersistedRunEvent[] = [];
      await collect(s.readEvents("r"), seen);
      expect(seen.map((e) => e.seq)).toEqual([0, 1]);
    });

    test("fromSeq skips earlier events", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      await s.appendEvents("r", [ready("a"), started("a"), ready("b")]);
      await s.finishRun("r", cancelledOutcome());
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
      await s.finishRun("r", cancelledOutcome());
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
      await s.finishRun("r", cancelledOutcome());
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
      await s.finishRun("r", cancelledOutcome());
      await expect(s.appendEvents("r", [ready("a")])).rejects.toThrow();
    });

    test("readEvents for an unknown run rejects on iteration", async () => {
      const s = open();
      await expect(collect(s.readEvents("nope"), [])).rejects.toThrow();
    });

    test("finishRun is idempotent", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      const first = cancelledOutcome({ requestedBy: "operator" });
      await s.finishRun("r", first);
      await expect(
        s.finishRun("r", { status: "succeeded", output: "ignored" }),
      ).resolves.toBeUndefined();
      expect(await s.getRun("r")).toMatchObject({
        finished: true,
        outcome: first,
      });
    });

    test("reopenRun clears the outcome and re-enables appends", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      await s.finishRun("r", cancelledOutcome());
      await s.reopenRun("r");

      const run = await s.getRun("r");
      expect(run?.finished).toBe(false);
      expect(run).not.toHaveProperty("outcome");
      // A reopened run accepts new events again.
      await expect(s.appendEvents("r", [ready("a")])).resolves.toBeDefined();
    });

    test("reopenRun rejects an unknown run and is idempotent", async () => {
      const s = open();
      await expect(s.reopenRun("nope")).rejects.toThrow();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      await s.reopenRun("r");
      await expect(s.reopenRun("r")).resolves.toBeUndefined();
    });

    test("listRuns is empty for a fresh store", async () => {
      expect(await open().listRuns()).toEqual([]);
    });

    test("listRuns returns summaries, most-recent-created first", async () => {
      const s = open();
      await s.createRun({ runId: "a", graph: fixtureGraph() });
      await s.createRun({ runId: "b", graph: fixtureGraph() });
      await s.finishRun("b", cancelledOutcome());

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
      await s.finishRun("a", cancelledOutcome());
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
      await s.finishRun("r", {
        status: "failed",
        failures: [
          {
            nodeId: "only",
            cause: { code: "X" },
            failureClass: "semantic_failed",
          },
        ],
      });
      const seen: PersistedRunEvent[] = [];
      await collect(s.readEvents("r"), seen);
      const event = seen[0];
      expect(event?.kind).toBe("node_failed");
      if (event?.kind === "node_failed") {
        expect(event.failure.failureClass).toBe("semantic_failed");
        expect(event.failure.cause).toEqual({ code: "X" });
      }
    });

    test("persistence snapshots mutable events and terminal outcomes", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      const output = { nested: { value: "before" } };
      const appended = await s.appendEvents("r", [
        { kind: "node_succeeded", nodeId: "only", output },
      ]);
      output.nested.value = "mutated";

      const reason = { requestedBy: { name: "before" } };
      await s.finishRun("r", cancelledOutcome(reason));
      reason.requestedBy.name = "mutated";

      const seen: PersistedRunEvent[] = [];
      await collect(s.readEvents("r"), seen);
      expect(seen[0]).toMatchObject({
        output: { nested: { value: "before" } },
      });
      expect(seen[0]).toEqual(appended[0]);
      expect(Object.isFrozen(seen[0])).toBe(true);
      if (seen[0]?.kind === "node_succeeded") {
        expect(Object.isFrozen(seen[0].output)).toBe(true);
      }

      const stored = await s.getRun("r");
      expect(stored?.outcome).toEqual(
        cancelledOutcome({ requestedBy: { name: "before" } }),
      );
      expect(Object.isFrozen(stored?.outcome)).toBe(true);
      if (stored?.finished === true && stored.outcome.status === "cancelled") {
        expect(Object.isFrozen(stored.outcome.reason)).toBe(true);
      }
    });

    test("rejects invalid JSON data without partially committing a batch", async () => {
      const s = open();
      await s.createRun({ runId: "r", graph: fixtureGraph() });
      const invalid = BigInt(1) as unknown as JsonValue;
      await expect(
        s.appendEvents("r", [
          ready("only"),
          { kind: "node_succeeded", nodeId: "only", output: invalid },
        ]),
      ).rejects.toThrow("JSON-safe");
      expect((await s.getRun("r"))?.revision).toBe(0);
      expect((await s.appendEvents("r", [ready("only")]))[0]?.seq).toBe(0);

      await expect(
        s.finishRun("r", { status: "succeeded", output: invalid }),
      ).rejects.toThrow("JSON-safe");
      expect((await s.getRun("r"))?.finished).toBe(false);
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

const cancelledOutcome = (reason: JsonValue = null) =>
  ({
    status: "cancelled",
    reason,
    failures: [],
  }) as const;

async function collect(
  iterable: AsyncIterable<PersistedRunEvent>,
  into: PersistedRunEvent[],
): Promise<void> {
  for await (const event of iterable) {
    into.push(event);
  }
}
