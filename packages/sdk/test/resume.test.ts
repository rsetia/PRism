import { describe, expect, test } from "vitest";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createManualClock,
  createMemoryStore,
  parseGraph,
} from "../src/index.js";
import type {
  CompiledGraph,
  Engine,
  ExecutorDefinition,
  FailureClass,
  ManualClock,
  PersistedRunEvent,
  RetryPolicy,
  RunEvent,
  RunHandle,
  RunStore,
} from "../src/index.js";

function buildGraph(definition: unknown): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

/** Seed a store with a partial event history — a crashed run to resume. */
async function seed(
  store: RunStore,
  runId: string,
  graph: CompiledGraph,
  events: readonly RunEvent[],
): Promise<void> {
  await store.createRun({ runId, graph });
  if (events.length > 0) {
    await store.appendEvents(runId, events);
  }
}

function engineOn(
  store: RunStore,
  extraExecutors: readonly ExecutorDefinition[] = [],
  options: {
    retryPolicy?: RetryPolicy;
    clock?: ManualClock;
    maxConcurrency?: number;
  } = {},
): Engine {
  return createEngine({
    store,
    registry: createExecutorRegistry([...builtinExecutors, ...extraExecutors]),
    ...options,
  });
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function drain(handle: RunHandle, clock: ManualClock): Promise<void> {
  let done = false;
  void handle.result.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  while (!done) {
    await settle();
    clock.advanceToNext();
  }
}

async function eventKinds(handle: RunHandle): Promise<string[]> {
  const seen: PersistedRunEvent[] = [];
  for await (const event of handle.events) {
    seen.push(event);
  }
  return seen.map((event) => event.kind);
}

const linearGraph = (): CompiledGraph =>
  buildGraph({
    version: 1,
    nodes: {
      a: { executor: "constant", config: { value: "A" } },
      b: { executor: "passthrough", dependsOn: ["a"] },
    },
    finalNode: "b",
  });

const transientRetry = (): RetryPolicy => ({
  maxAttempts: 3,
  retryableClasses: new Set<FailureClass>(["transient_infra"]),
  baseDelayMs: 100,
  maxDelayMs: 1_000,
});

describe("engine resume", () => {
  test("fails a malformed ready node instead of rejecting the scheduler", async () => {
    const store = createMemoryStore();
    const graph = linearGraph();
    // This represents corrupt/incomplete persisted state: b was marked ready
    // but its dependency output was never recorded. The engine must surface a
    // normal node failure rather than abandon the entire scheduler promise.
    await seed(store, "missing-dependency", graph, [
      { kind: "node_ready", nodeId: "b" },
    ]);

    await expect(
      engineOn(store, [], { maxConcurrency: 2 }).resume("missing-dependency")
        .result,
    ).resolves.toEqual({
      status: "failed",
      failures: [
        {
          nodeId: "b",
          cause: {
            name: "Error",
            message: 'node "b" is missing output from dependency "a"',
          },
        },
      ],
    });
  });

  test("restores null output for a previously skipped dependency", async () => {
    const store = createMemoryStore();
    const graph = buildGraph({
      version: 2,
      nodes: {
        proof: {
          executor: "constant",
          config: { value: { proof: { version: 1, hasDiff: false } } },
        },
        gated: {
          executor: "constant",
          dependsOn: ["proof"],
          config: { value: "not run" },
          when: { predicate: "diff_present", equals: true },
        },
        final: { executor: "passthrough", dependsOn: ["gated"] },
      },
      finalNode: "final",
    });
    await seed(store, "skipped", graph, [
      { kind: "node_ready", nodeId: "proof" },
      { kind: "node_started", nodeId: "proof" },
      {
        kind: "node_succeeded",
        nodeId: "proof",
        output: { proof: { version: 1, hasDiff: false } },
      },
      { kind: "node_skipped", nodeId: "gated" },
    ]);

    await expect(engineOn(store).resume("skipped").result).resolves.toEqual({
      status: "succeeded",
      output: null,
    });
  });

  test("continues a run whose upstream node already succeeded", async () => {
    const store = createMemoryStore();
    // 'a' finished; 'b' was made ready but never started (crash here).
    await seed(store, "r", linearGraph(), [
      { kind: "node_ready", nodeId: "a" },
      { kind: "node_started", nodeId: "a" },
      { kind: "node_succeeded", nodeId: "a", output: "A" },
      { kind: "node_ready", nodeId: "b" },
    ]);

    const handle = engineOn(store).resume("r");
    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "A",
    });
    // 'a' is not re-run; only 'b' produces new lifecycle events.
    const kinds = await eventKinds(handle);
    expect(kinds.filter((k) => k === "node_started")).toHaveLength(2);
  });

  test("does not re-run an already-succeeded node", async () => {
    const store = createMemoryStore();
    let bCalls = 0;
    const countingB: ExecutorDefinition = {
      name: "counting",
      execute() {
        bCalls += 1;
        return { status: "succeeded", output: "B" };
      },
    };
    const graph = buildGraph({
      version: 1,
      nodes: {
        a: { executor: "constant", config: { value: "A" } },
        b: { executor: "counting", dependsOn: ["a"] },
      },
      finalNode: "b",
    });
    await seed(store, "r", graph, [
      { kind: "node_ready", nodeId: "a" },
      { kind: "node_started", nodeId: "a" },
      { kind: "node_succeeded", nodeId: "a", output: "A" },
      { kind: "node_ready", nodeId: "b" },
      { kind: "node_started", nodeId: "b" },
      { kind: "node_succeeded", nodeId: "b", output: "B" },
    ]);
    // Both nodes already succeeded and the run was finished.
    await store.finishRun("r", { status: "succeeded", output: "B" });

    const outcome = await engineOn(store, [countingB]).resume("r").result;
    expect(outcome).toEqual({ status: "succeeded", output: "B" });
    expect(bCalls).toBe(0); // finished run — nothing re-executes
  });

  test("replays the exact persisted outcome for a preflight failure", async () => {
    const store = createMemoryStore();
    const graph = buildGraph({
      version: 1,
      nodes: { ghost: { executor: "missing" } },
      finalNode: "ghost",
    });
    const first = await engineOn(store).run(graph, { runId: "preflight" })
      .result;
    expect(first).toEqual({
      status: "failed",
      failures: [
        {
          nodeId: "ghost",
          cause: { code: "UNKNOWN_EXECUTOR", executor: "missing" },
        },
      ],
    });
    expect(await eventKinds(engineOn(store).resume("preflight"))).toEqual([]);

    const stored = await store.getRun("preflight");
    expect(stored?.finished).toBe(true);
    expect(stored?.outcome).toEqual(first);
    await expect(engineOn(store).resume("preflight").result).resolves.toEqual(
      first,
    );
  });

  test("reclassifies a crashed running node as transient_infra", async () => {
    const store = createMemoryStore();
    const graph = buildGraph({
      version: 1,
      nodes: { a: { executor: "constant", config: { value: "A" } } },
      finalNode: "a",
    });
    // 'a' was running when the process died — no terminal event.
    await seed(store, "r", graph, [
      { kind: "node_ready", nodeId: "a" },
      { kind: "node_started", nodeId: "a" },
    ]);

    // No retry policy: the reclassified failure is terminal.
    const outcome = await engineOn(store).resume("r").result;
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failures[0]?.nodeId).toBe("a");
      expect(outcome.failures[0]?.failureClass).toBe("transient_infra");
    }
  });

  test("a crashed running node is retried when the policy allows", async () => {
    const store = createMemoryStore();
    const clock = createManualClock();
    const graph = buildGraph({
      version: 1,
      nodes: { a: { executor: "constant", config: { value: "A" } } },
      finalNode: "a",
    });
    await seed(store, "r", graph, [
      { kind: "node_ready", nodeId: "a" },
      { kind: "node_started", nodeId: "a" },
    ]);

    const engine = engineOn(store, [], {
      retryPolicy: transientRetry(),
      clock,
    });
    const handle = engine.resume("r");
    await drain(handle, clock);
    // Reclassified -> retryable -> re-run 'constant' -> succeeds.
    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "A",
    });
  });

  test("a resumed resource waiter runs after an interrupted owner releases", async () => {
    const store = createMemoryStore();
    const clock = createManualClock();
    const graph = buildGraph({
      version: 1,
      resources: { shared: { capacity: 1 } },
      nodes: {
        a: {
          executor: "constant",
          resources: ["shared"],
          config: { value: "A" },
        },
        b: {
          executor: "constant",
          resources: ["shared"],
          config: { value: "B" },
        },
      },
      finalNode: "a",
    });
    await seed(store, "resource-resume", graph, [
      { kind: "node_ready", nodeId: "a" },
      { kind: "node_ready", nodeId: "b" },
      { kind: "node_started", nodeId: "a" },
      {
        kind: "node_resource_wait",
        nodeId: "b",
        resourceIds: ["shared"],
      },
    ]);

    const handle = engineOn(store, [], {
      retryPolicy: transientRetry(),
      clock,
    }).resume("resource-resume");
    await drain(handle, clock);
    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "A",
    });
    const started: string[] = [];
    for await (const event of handle.events) {
      if (event.kind === "node_started") started.push(event.nodeId);
    }
    expect(started).toEqual(["a", "b", "a"]);
  });

  test("resuming an unknown run rejects", async () => {
    const store = createMemoryStore();
    await expect(engineOn(store).resume("nope").result).rejects.toThrow();
  });
});
