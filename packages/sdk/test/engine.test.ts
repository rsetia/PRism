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
  RunStore,
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
  maxConcurrency?: number,
): Engine {
  return createEngine({
    store: createMemoryStore(),
    registry: createExecutorRegistry([...builtinExecutors, ...extraExecutors]),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
  });
}

/** `kind:nodeId` for every event, in order — the event-fixture format. */
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

/**
 * Controlled-promise executor: the TEST holds every node's completion
 * and releases each one deliberately. This is how ordering and the
 * concurrency bound get proven without wall-clock waits.
 */
interface ControlledStart {
  readonly nodeId: string;
  readonly inputs: readonly JsonValue[];
  readonly succeed: (output: JsonValue) => void;
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
          inputs: context.inputs,
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

describe("createEngine", () => {
  test("rejects an invalid maxConcurrency", () => {
    for (const maxConcurrency of [0, -1, 1.5, Number.NaN]) {
      expect(() => engineWith([], maxConcurrency)).toThrow();
    }
  });

  test("runs a linear graph end to end", async () => {
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
  });

  test("inputs arrive in dependsOn order, not topo order", async () => {
    const build = (dependsOn: readonly string[]) =>
      buildGraph({
        version: 1,
        nodes: {
          hello: { executor: "constant", config: { value: "hello" } },
          world: { executor: "constant", config: { value: "world" } },
          joined: {
            executor: "concat",
            dependsOn,
            config: { separator: " " },
          },
        },
        finalNode: "joined",
      });
    const forward = await engineWith().run(build(["hello", "world"])).result;
    expect(forward).toEqual({ status: "succeeded", output: "hello world" });
    const reversed = await engineWith().run(build(["world", "hello"])).result;
    expect(reversed).toEqual({ status: "succeeded", output: "world hello" });
  });

  test("emits the exact event sequence for a linear run", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        first: { executor: "constant", config: { value: 1 } },
        second: { executor: "passthrough", dependsOn: ["first"] },
      },
      finalNode: "second",
    });
    const handle = engineWith().run(graph);
    expect(await eventSummary(handle)).toEqual([
      "node_ready:first",
      "node_started:first",
      "node_succeeded:first",
      "node_ready:second",
      "node_started:second",
      "node_succeeded:second",
    ]);
  });

  test("persists executor-reported phases before node completion", async () => {
    const phased: ExecutorDefinition = {
      name: "phased",
      async execute(context) {
        await context.reportPhase("validation");
        return { status: "succeeded", output: null };
      },
    };
    const graph = buildGraph({
      version: 1,
      nodes: { work: { executor: "phased" } },
      finalNode: "work",
    });
    const handle = engineWith([phased]).run(graph);
    const phases: string[] = [];
    for await (const event of handle.events) {
      if (event.kind === "node_phase_changed") phases.push(event.phase);
    }

    expect(phases).toEqual(["validation"]);
    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: null,
    });
  });

  test("one rejected append fails its node, not every append after it", async () => {
    const base = createMemoryStore();
    let failOnce = true;
    const flaky: RunStore = {
      ...base,
      appendEvents(runId, events, expectedRevision) {
        if (
          failOnce &&
          events.some((event) => event.kind === "node_phase_changed")
        ) {
          failOnce = false;
          return Promise.reject(new Error("transient store failure"));
        }
        return base.appendEvents(runId, events, expectedRevision);
      },
    };
    const phased: ExecutorDefinition = {
      name: "phased",
      async execute(context) {
        await context.reportPhase("validation");
        return { status: "succeeded", output: null };
      },
    };
    const engine = createEngine({
      store: flaky,
      registry: createExecutorRegistry([...builtinExecutors, phased]),
    });
    const graph = buildGraph({
      version: 1,
      nodes: { work: { executor: "phased" } },
      finalNode: "work",
    });

    // The phase append rejects, so its node fails — but the follow-up
    // node_failed append must not inherit the rejection: the run itself
    // still resolves with an ordinary failed outcome.
    const outcome = await engine.run(graph).result;
    expect(outcome.status).toBe("failed");
  });

  test("a failed node fails the run with originating failures only", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        doomed: { executor: "fail", config: { reason: "boom" } },
        after: { executor: "passthrough", dependsOn: ["doomed"] },
      },
      finalNode: "after",
    });
    const handle = engineWith().run(graph);
    await expect(handle.result).resolves.toEqual({
      status: "failed",
      failures: [{ nodeId: "doomed", cause: { reason: "boom" } }],
    });
    expect(await eventSummary(handle)).toEqual([
      "node_ready:doomed",
      "node_started:doomed",
      "node_failed:doomed",
      "node_blocked:after",
    ]);
  });

  test("blocking propagates transitively; blockedBy names direct deps", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        doomed: { executor: "fail" },
        mid: { executor: "passthrough", dependsOn: ["doomed"] },
        last: { executor: "passthrough", dependsOn: ["mid"] },
      },
      finalNode: "last",
    });
    const handle = engineWith().run(graph);
    const outcome = await handle.result;
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failures.map((f) => f.nodeId)).toEqual(["doomed"]);
    }
    const blockedBy = new Map<string, readonly string[]>();
    for await (const event of handle.events) {
      if (event.kind === "node_blocked") {
        blockedBy.set(event.nodeId, event.blockedBy);
      }
    }
    expect(blockedBy.get("mid")).toEqual(["doomed"]);
    expect(blockedBy.get("last")).toEqual(["mid"]);
  });

  test("an independent branch still completes after a failure", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        a: { executor: "constant", config: { value: "ok" } },
        b: { executor: "passthrough", dependsOn: ["a"] },
        c: { executor: "fail" },
        d: { executor: "passthrough", dependsOn: ["c"] },
      },
      finalNode: "b",
    });
    const handle = engineWith().run(graph);
    const outcome = await handle.result;
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failures.map((f) => f.nodeId)).toEqual(["c"]);
    }
    const summary = await eventSummary(handle);
    expect(summary).toContain("node_succeeded:b");
    expect(summary).toContain("node_blocked:d");
  });

  test("preflight: an unknown executor fails the run before any node event", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        a: { executor: "constant", config: { value: 1 } },
        ghost: { executor: "missing" },
      },
      finalNode: "a",
    });
    const handle = engineWith().run(graph);
    await expect(handle.result).resolves.toEqual({
      status: "failed",
      failures: [
        {
          nodeId: "ghost",
          cause: { code: "UNKNOWN_EXECUTOR", executor: "missing" },
        },
      ],
    });
    expect(await eventSummary(handle)).toEqual([]);
  });

  test("a throwing executor is normalized, never an unhandled rejection", async () => {
    const thrower: ExecutorDefinition = {
      name: "thrower",
      execute() {
        throw new RangeError("exploded");
      },
    };
    const graph = buildGraph({
      version: 1,
      nodes: { t: { executor: "thrower" } },
      finalNode: "t",
    });
    const handle = engineWith([thrower]).run(graph);
    await expect(handle.result).resolves.toEqual({
      status: "failed",
      failures: [
        { nodeId: "t", cause: { name: "RangeError", message: "exploded" } },
      ],
    });
  });

  test("a persistence failure rejects without falsely finishing the run", async () => {
    const base = createMemoryStore();
    const store: RunStore = {
      ...base,
      appendEvents() {
        return Promise.reject(new Error("persistence unavailable"));
      },
    };
    const engine = createEngine({
      store,
      registry: createExecutorRegistry(builtinExecutors),
    });
    const graph = buildGraph({
      version: 1,
      nodes: { work: { executor: "constant", config: { value: "ok" } } },
      finalNode: "work",
    });

    await expect(
      engine.run(graph, { runId: "not-finished" }).result,
    ).rejects.toThrow("persistence unavailable");
    expect(await base.getRun("not-finished")).toMatchObject({
      finished: false,
      revision: 0,
    });
  });

  test("dependencies never start early, and outputs flow through", async () => {
    const controlled = createControlledExecutor();
    const graph = buildGraph({
      version: 1,
      nodes: {
        a: { executor: "controlled" },
        b: { executor: "controlled", dependsOn: ["a"] },
      },
      finalNode: "b",
    });
    const handle = engineWith([controlled.definition], 2).run(graph);
    const first = await controlled.nextStart();
    expect(first.nodeId).toBe("a");
    await settle();
    expect(controlled.starts).toHaveLength(1);
    first.succeed("from-a");
    const second = await controlled.nextStart();
    expect(second.nodeId).toBe("b");
    expect(second.inputs).toEqual(["from-a"]);
    second.succeed("done");
    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "done",
    });
  });

  test("concurrency never exceeds the bound; freed slots refill", async () => {
    const controlled = createControlledExecutor();
    const graph = buildGraph({
      version: 1,
      nodes: {
        a: { executor: "controlled" },
        b: { executor: "controlled" },
        c: { executor: "controlled" },
      },
      finalNode: "a",
    });
    const handle = engineWith([controlled.definition], 2).run(graph);
    const first = await controlled.nextStart();
    const second = await controlled.nextStart();
    await settle();
    expect(controlled.starts).toHaveLength(2);
    expect([first.nodeId, second.nodeId]).toEqual(["a", "b"]);
    first.succeed(null);
    const third = await controlled.nextStart();
    expect(third.nodeId).toBe("c");
    second.succeed(null);
    third.succeed(null);
    const outcome = await handle.result;
    expect(outcome.status).toBe("succeeded");
  });

  test("default concurrency is 1, selecting in stable lexicographic order", async () => {
    const controlled = createControlledExecutor();
    const graph = buildGraph({
      version: 1,
      nodes: {
        c: { executor: "controlled" },
        b: { executor: "controlled" },
        a: { executor: "controlled" },
      },
      finalNode: "a",
    });
    const handle = engineWith([controlled.definition]).run(graph);
    const executed: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const start = await controlled.nextStart();
      await settle();
      expect(controlled.starts).toHaveLength(i + 1);
      executed.push(start.nodeId);
      start.succeed(null);
    }
    expect(executed).toEqual(["a", "b", "c"]);
    const outcome = await handle.result;
    expect(outcome.status).toBe("succeeded");
  });

  test("honors a caller runId; generated ids are distinct", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { only: { executor: "constant", config: { value: 1 } } },
      finalNode: "only",
    });
    const engine = engineWith();
    const custom = engine.run(graph, { runId: "my-run" });
    expect(custom.id).toBe("my-run");
    const one = engine.run(graph);
    const two = engine.run(graph);
    expect(one.id).not.toBe(two.id);
    expect(one.id.length).toBeGreaterThan(0);
    await Promise.all([custom.result, one.result, two.result]);
  });

  test("events can be iterated late and more than once", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: {
        first: { executor: "constant", config: { value: 1 } },
        second: { executor: "passthrough", dependsOn: ["first"] },
      },
      finalNode: "second",
    });
    const handle = engineWith().run(graph);
    await handle.result;
    const once = await eventSummary(handle);
    const twice = await eventSummary(handle);
    expect(once).toHaveLength(6);
    expect(twice).toEqual(once);
  });
});
