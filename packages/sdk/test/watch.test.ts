import { describe, expect, test } from "vitest";
import {
  compileGraph,
  createManualClock,
  createMemoryStore,
  parseGraph,
  watchRun,
} from "../src/index.js";
import type { CompiledGraph } from "../src/index.js";

function fixtureGraph(): CompiledGraph {
  const parsed = parseGraph({
    version: 1,
    nodes: { work: { executor: "constant", config: { value: "done" } } },
    finalNode: "work",
  });
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

describe("watchRun", () => {
  test("yields immediately, polls through Clock, and stops when finished", async () => {
    const store = createMemoryStore();
    const clock = createManualClock();
    await store.createRun({ runId: "r", graph: fixtureGraph() });
    const iterator = watchRun(store, "r", {
      clock,
      intervalMs: 25,
    })[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (first.done === true)
      throw new Error("watch ended before first snapshot");
    expect(first.value.finished).toBe(false);
    expect(first.value.nodes[0]?.state).toBe("pending");
    expect(clock.pending).toBe(0);

    const nextSnapshot = iterator.next();
    await Promise.resolve();
    expect(clock.pending).toBe(1);
    await store.appendEvents("r", [
      { kind: "node_ready", nodeId: "work" },
      { kind: "node_started", nodeId: "work" },
      { kind: "node_succeeded", nodeId: "work", output: "done" },
    ]);
    await store.finishRun("r");
    clock.advance(25);

    const second = await nextSnapshot;
    expect(second.done).toBe(false);
    if (second.done === true) {
      throw new Error("watch ended before terminal snapshot");
    }
    expect(second.value.finished).toBe(true);
    expect(second.value.nodes[0]?.state).toBe("succeeded");
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(clock.pending).toBe(0);
  });

  test("a finished run yields once without scheduling a wait", async () => {
    const store = createMemoryStore();
    const clock = createManualClock();
    await store.createRun({ runId: "done", graph: fixtureGraph() });
    await store.appendEvents("done", [
      { kind: "node_ready", nodeId: "work" },
      { kind: "node_started", nodeId: "work" },
      { kind: "node_succeeded", nodeId: "work", output: "done" },
    ]);
    await store.finishRun("done");

    const snapshots = [];
    for await (const snapshot of watchRun(store, "done", { clock })) {
      snapshots.push(snapshot);
    }
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.finished).toBe(true);
    expect(clock.pending).toBe(0);
  });

  test("rejects an invalid polling interval eagerly", () => {
    const store = createMemoryStore();
    const clock = createManualClock();
    expect(() => watchRun(store, "r", { clock, intervalMs: 0 })).toThrow(
      "intervalMs",
    );
    expect(() =>
      watchRun(store, "r", { clock, intervalMs: Number.NaN }),
    ).toThrow("intervalMs");
  });

  test("rejects an unknown run on the first snapshot", async () => {
    const iterator = watchRun(createMemoryStore(), "missing", {
      clock: createManualClock(),
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow('unknown run: "missing"');
  });

  test("an abort signal interrupts the polling wait", async () => {
    const store = createMemoryStore();
    const clock = createManualClock();
    const controller = new AbortController();
    await store.createRun({ runId: "r", graph: fixtureGraph() });
    const iterator = watchRun(store, "r", {
      clock,
      intervalMs: 100,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    await iterator.next();

    const waiting = iterator.next();
    await Promise.resolve();
    expect(clock.pending).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(clock.pending).toBe(0);
  });
});
