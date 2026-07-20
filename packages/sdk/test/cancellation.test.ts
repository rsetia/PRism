import { describe, expect, test } from "vitest";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  parseGraph,
} from "../src/index.js";
import type {
  CompiledGraph,
  Engine,
  ExecutorDefinition,
  JsonValue,
  RunHandle,
} from "../src/index.js";

function buildGraph(definition: unknown): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

function engineWith(
  extraExecutors: readonly ExecutorDefinition[] = [],
  options: { maxConcurrency?: number; cancelGracePeriodMs?: number } = {},
): Engine {
  return createEngine({
    store: createMemoryStore(),
    registry: createExecutorRegistry([...builtinExecutors, ...extraExecutors]),
    ...options,
  });
}

async function eventSummary(handle: RunHandle): Promise<string[]> {
  const seen: string[] = [];
  for await (const event of handle.events) {
    seen.push(`${event.kind}:${event.nodeId}`);
  }
  return seen;
}

/** Flush pending microtasks and one macrotask tick. Not a real sleep. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface ControlledStart {
  readonly nodeId: string;
  readonly signal: AbortSignal;
  readonly succeed: (output: unknown) => void;
  readonly fail: (cause: JsonValue) => void;
}

function createControlledExecutor(name = "controlled"): {
  definition: ExecutorDefinition;
  starts: ControlledStart[];
  nextStart: () => Promise<ControlledStart>;
} {
  const starts: ControlledStart[] = [];
  const unclaimed: ControlledStart[] = [];
  const waiters: ((start: ControlledStart) => void)[] = [];

  const definition: ExecutorDefinition = {
    name,
    execute(context) {
      return new Promise((resolve) => {
        const start: ControlledStart = {
          nodeId: context.nodeId,
          signal: context.signal,
          succeed: (output) => resolve({ status: "succeeded", output }),
          fail: (cause) => resolve({ status: "failed", cause }),
        };
        starts.push(start);
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter(start);
        else unclaimed.push(start);
      });
    },
  };

  return {
    definition,
    starts,
    nextStart() {
      const start = unclaimed.shift();
      if (start !== undefined) return Promise.resolve(start);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

describe("cancellation", () => {
  test("cancel aborts the running node and cancels pending descendants", async () => {
    const controlled = createControlledExecutor();
    const graph = buildGraph({
      version: 1,
      nodes: {
        slow: { executor: "controlled" },
        after: { executor: "passthrough", dependsOn: ["slow"] },
      },
      finalNode: "after",
    });
    const handle = engineWith([controlled.definition]).run(graph);
    const start = await controlled.nextStart();
    expect(start.signal.aborted).toBe(false);

    const cancelled = handle.cancel({ why: "test" });
    await settle();
    expect(start.signal.aborted).toBe(true);

    // The executor settles late; its outcome must be discarded.
    start.succeed("late-output");
    await cancelled;

    await expect(handle.result).resolves.toEqual({
      status: "cancelled",
      reason: { why: "test" },
      failures: [],
    });
    const summary = await eventSummary(handle);
    expect(summary.filter((line) => line.endsWith(":slow"))).toEqual([
      "node_ready:slow",
      "node_started:slow",
      "node_cancelling:slow",
      "node_cancelled:slow",
    ]);
    expect(summary).toContain("node_cancelled:after");
    expect(summary).not.toContain("node_succeeded:slow");
  });

  test("a completion persisted before cancellation stays won", async () => {
    const controlled = createControlledExecutor();
    const graph = buildGraph({
      version: 1,
      nodes: {
        a: { executor: "controlled" },
        b: { executor: "controlled" },
      },
      finalNode: "a",
    });
    const handle = engineWith([controlled.definition], {
      maxConcurrency: 2,
    }).run(graph);
    const first = await controlled.nextStart();
    const second = await controlled.nextStart();

    first.succeed("done");
    await settle();

    const cancelled = handle.cancel();
    await settle();
    second.succeed("late");
    await cancelled;

    const outcome = await handle.result;
    expect(outcome.status).toBe("cancelled");
    const summary = await eventSummary(handle);
    expect(summary).toContain(`node_succeeded:${first.nodeId}`);
    expect(summary).not.toContain(`node_cancelled:${first.nodeId}`);
    expect(summary).toContain(`node_cancelling:${second.nodeId}`);
    expect(summary).toContain(`node_cancelled:${second.nodeId}`);
  });

  test("default reason is null; failures before cancellation are kept", async () => {
    const controlled = createControlledExecutor();
    const graph = buildGraph({
      version: 1,
      nodes: {
        doomed: { executor: "fail", config: { reason: "boom" } },
        slow: { executor: "controlled" },
      },
      finalNode: "slow",
    });
    const handle = engineWith([controlled.definition], {
      maxConcurrency: 2,
    }).run(graph);
    const start = await controlled.nextStart();
    await settle(); // let "doomed" fail and persist

    const cancelled = handle.cancel();
    await settle();
    start.succeed("late");
    await cancelled;

    await expect(handle.result).resolves.toEqual({
      status: "cancelled",
      reason: null,
      failures: [{ nodeId: "doomed", cause: { reason: "boom" } }],
    });
  });

  test("cancel after completion is a no-op", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        first: { executor: "constant", config: { value: "hello" } },
        second: { executor: "passthrough", dependsOn: ["first"] },
      },
      finalNode: "second",
    });
    const handle = engineWith().run(graph);
    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "hello",
    });
    await handle.cancel({ why: "too late" });
    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "hello",
    });
  });

  test("cancel is idempotent while in flight", async () => {
    const controlled = createControlledExecutor();
    const graph = buildGraph({
      version: 1,
      nodes: { slow: { executor: "controlled" } },
      finalNode: "slow",
    });
    const handle = engineWith([controlled.definition]).run(graph);
    const start = await controlled.nextStart();

    const first = handle.cancel();
    const second = handle.cancel();
    await settle();
    start.succeed("late");
    await Promise.all([first, second]);

    const outcome = await handle.result;
    expect(outcome.status).toBe("cancelled");
  });

  test("grace period abandons a non-cooperative executor", async () => {
    const stubborn: ExecutorDefinition = {
      name: "stubborn",
      execute() {
        // Never settles and ignores the abort signal entirely.
        return new Promise(() => undefined);
      },
    };
    const graph = buildGraph({
      version: 1,
      nodes: { stuck: { executor: "stubborn" } },
      finalNode: "stuck",
    });
    const handle = engineWith([stubborn], { cancelGracePeriodMs: 25 }).run(
      graph,
    );
    await settle(); // let "stuck" start
    await handle.cancel();

    const outcome = await handle.result;
    expect(outcome.status).toBe("cancelled");
    const summary = await eventSummary(handle);
    expect(summary).toContain("node_started:stuck");
    expect(summary).toContain("node_cancelled:stuck");
  });
});
