import { describe, expect, test } from "vitest";
import { compileGraph, createMemoryStore, parseGraph } from "../src/index.js";
import type {
  CompiledGraph,
  PersistedRunEvent,
  RunEvent,
} from "../src/index.js";

function tinyGraph(): CompiledGraph {
  const parsed = parseGraph({
    version: 1,
    nodes: { only: { executor: "constant", config: { value: 1 } } },
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

describe("createMemoryStore", () => {
  test("createRun + getRun roundtrip", async () => {
    const store = createMemoryStore();
    const graph = tinyGraph();
    await store.createRun({ runId: "r", graph });
    const run = await store.getRun("r");
    expect(run?.runId).toBe("r");
    expect(run?.finished).toBe(false);
    expect(run?.graph).toEqual(graph);
  });

  test("getRun for an unknown run returns undefined", async () => {
    const store = createMemoryStore();
    expect(await store.getRun("nope")).toBeUndefined();
  });

  test("createRun rejects a duplicate runId", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "r", graph: tinyGraph() });
    await expect(
      store.createRun({ runId: "r", graph: tinyGraph() }),
    ).rejects.toThrow();
  });

  test("appendEvents assigns gapless seq from 0 across batches", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "r", graph: tinyGraph() });
    const first = await store.appendEvents("r", [ready("a"), started("a")]);
    const second = await store.appendEvents("r", [ready("b")]);
    expect(first.map((e) => e.seq)).toEqual([0, 1]);
    expect(second.map((e) => e.seq)).toEqual([2]);
    expect(first[0]?.kind).toBe("node_ready");
  });

  test("late subscriber sees full history, then completes", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "r", graph: tinyGraph() });
    await store.appendEvents("r", [ready("a"), started("a")]);
    await store.finishRun("r");
    const seen: PersistedRunEvent[] = [];
    await collect(store.readEvents("r"), seen);
    expect(seen.map((e) => e.seq)).toEqual([0, 1]);
  });

  test("fromSeq cursor skips earlier events", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "r", graph: tinyGraph() });
    await store.appendEvents("r", [ready("a"), started("a"), ready("b")]);
    await store.finishRun("r");
    const seen: PersistedRunEvent[] = [];
    await collect(store.readEvents("r", 1), seen);
    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("live subscriber receives events appended after it starts", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "r", graph: tinyGraph() });
    const seen: PersistedRunEvent[] = [];
    const done = collect(store.readEvents("r"), seen);
    await store.appendEvents("r", [ready("a")]);
    await store.appendEvents("r", [started("a")]);
    await store.finishRun("r");
    await done;
    expect(seen.map((e) => e.seq)).toEqual([0, 1]);
  });

  test("multiple consumers each own a cursor and see everything", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "r", graph: tinyGraph() });
    const early: PersistedRunEvent[] = [];
    const doneEarly = collect(store.readEvents("r"), early);
    await store.appendEvents("r", [ready("a")]);
    const late: PersistedRunEvent[] = [];
    const doneLate = collect(store.readEvents("r"), late);
    await store.appendEvents("r", [started("a")]);
    await store.finishRun("r");
    await Promise.all([doneEarly, doneLate]);
    expect(early.map((e) => e.seq)).toEqual([0, 1]);
    expect(late.map((e) => e.seq)).toEqual([0, 1]);
  });

  test("appendEvents rejects for an unknown run", async () => {
    const store = createMemoryStore();
    await expect(store.appendEvents("nope", [ready("a")])).rejects.toThrow();
  });

  test("appendEvents rejects after finishRun", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "r", graph: tinyGraph() });
    await store.finishRun("r");
    await expect(store.appendEvents("r", [ready("a")])).rejects.toThrow();
  });

  test("readEvents for an unknown run rejects on iteration", async () => {
    const store = createMemoryStore();
    await expect(collect(store.readEvents("nope"), [])).rejects.toThrow();
  });

  test("finishRun is idempotent", async () => {
    const store = createMemoryStore();
    await store.createRun({ runId: "r", graph: tinyGraph() });
    await store.finishRun("r");
    await expect(store.finishRun("r")).resolves.toBeUndefined();
  });
});
