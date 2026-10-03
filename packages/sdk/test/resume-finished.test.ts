import { describe, expect, test } from "vitest";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  inspectRun,
  parseGraph,
} from "../src/index.js";
import type {
  CompiledGraph,
  ExecutorDefinition,
  FailureClass,
  NodeState,
  RunStore,
} from "../src/index.js";

function buildGraph(definition: unknown): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

const graph = (): CompiledGraph =>
  buildGraph({
    version: 1,
    nodes: {
      flaky: { executor: "flaky" },
      after: { executor: "passthrough", dependsOn: ["flaky"] },
    },
    finalNode: "after",
  });

/** Fails the first `failures` executions with the given failure, then succeeds. */
function flaky(
  failures: number,
  failure: { failureClass?: FailureClass; cause: unknown },
): ExecutorDefinition & { calls: () => number } {
  let calls = 0;
  return {
    name: "flaky",
    calls: () => calls,
    execute: () => {
      calls += 1;
      if (calls <= failures) {
        return {
          status: "failed",
          cause: failure.cause as never,
          ...(failure.failureClass === undefined
            ? {}
            : { failureClass: failure.failureClass }),
        };
      }
      return { status: "succeeded", output: "recovered" };
    },
  };
}

function engineOn(store: RunStore, extra: ExecutorDefinition) {
  return createEngine({
    store,
    registry: createExecutorRegistry([...builtinExecutors, extra]),
  });
}

function stateOf(
  nodes: readonly { nodeId: string; state: NodeState }[],
  nodeId: string,
): NodeState | undefined {
  return nodes.find((n) => n.nodeId === nodeId)?.state;
}

describe("resume of a finished, failed run", () => {
  test("re-runs a transient failure and its blocked dependents to success", async () => {
    const store = createMemoryStore();
    const executor = flaky(1, {
      failureClass: "transient_infra",
      cause: {
        code: "CODEX_EXECUTION_FAILED",
        error: "could not lock config file",
      },
    });
    const engine = engineOn(store, executor);

    const first = await engine.run(graph(), { runId: "r" }).result;
    expect(first.status).toBe("failed");
    const failed = await inspectRun(store, "r");
    expect(failed.finished).toBe(true);
    expect(stateOf(failed.nodes, "after")).toBe("blocked");

    const resumed = await engine.resume("r").result;
    expect(resumed.status).toBe("succeeded");
    expect(executor.calls()).toBe(2);
    const done = await inspectRun(store, "r");
    expect(done.finished).toBe(true);
    expect(stateOf(done.nodes, "flaky")).toBe("succeeded");
    expect(stateOf(done.nodes, "after")).toBe("succeeded");

    // The original failure stays in the audit trail.
    const kinds: string[] = [];
    for await (const event of store.readEvents("r")) {
      if (event.nodeId === "flaky") kinds.push(event.kind);
    }
    expect(kinds).toContain("node_failed");
    expect(kinds).toContain("node_reset");
  });

  test("an unclassified failure counts as transient", async () => {
    const store = createMemoryStore();
    const executor = flaky(1, { cause: "boom" });
    const engine = engineOn(store, executor);
    await engine.run(graph(), { runId: "u" }).result;
    const resumed = await engine.resume("u").result;
    expect(resumed.status).toBe("succeeded");
  });

  test("leaves a non-retryable failure failed", async () => {
    const store = createMemoryStore();
    const executor = flaky(1, {
      failureClass: "manual_review_required",
      cause: "review budget exhausted",
    });
    const engine = engineOn(store, executor);
    const first = await engine.run(graph(), { runId: "n" }).result;
    const resumed = await engine.resume("n").result;
    expect(resumed).toEqual(first);
    expect(executor.calls()).toBe(1);
  });

  test("leaves an adjudicated worker failure failed even if transient-classed", async () => {
    const store = createMemoryStore();
    const executor = flaky(1, {
      failureClass: "transient_infra",
      cause: { code: "WORKER_FAILURE_ADJUDICATED", error: "no review" },
    });
    const engine = engineOn(store, executor);
    const first = await engine.run(graph(), { runId: "a" }).result;
    const resumed = await engine.resume("a").result;
    expect(resumed).toEqual(first);
    expect(executor.calls()).toBe(1);
  });

  test("refuses to reopen while another coordinator holds the lease", async () => {
    const store = createMemoryStore();
    const executor = flaky(1, { failureClass: "transient_infra", cause: "x" });
    const engine = engineOn(store, executor);
    await engine.run(graph(), { runId: "l" }).result;
    const lease = await store.acquireCoordinatorLease("l", "other", 60_000);
    await expect(engine.resume("l").result).rejects.toThrow(
      /active coordinator lease/,
    );
    await store.releaseLease(lease);
    expect(executor.calls()).toBe(1);
    const resumed = await engine.resume("l").result;
    expect(resumed.status).toBe("succeeded");
  });
});
