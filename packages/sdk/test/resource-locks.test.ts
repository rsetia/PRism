import { describe, expect, test } from "vitest";
import {
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createManualClock,
  createMemoryStore,
  parseGraph,
} from "../src/index.js";
import type {
  CompiledGraph,
  ExecutorDefinition,
  JsonValue,
  RunHandle,
} from "../src/index.js";

function graph(nodes: Record<string, unknown>, finalNode = "a"): CompiledGraph {
  const parsed = parseGraph({
    version: 1,
    resources: { shared: { capacity: 1 } },
    nodes,
    finalNode,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.graph;
}

interface Start {
  readonly nodeId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  succeed(output?: JsonValue): void;
  fail(): void;
}

function controlled(): {
  readonly definition: ExecutorDefinition;
  next(): Promise<Start>;
} {
  const queued: Start[] = [];
  const waiters: Array<(start: Start) => void> = [];
  return {
    definition: {
      name: "controlled",
      execute(context) {
        return new Promise((resolve) => {
          const start: Start = {
            nodeId: context.nodeId,
            attempt: context.attempt,
            signal: context.signal,
            succeed: (output = null) =>
              resolve({ status: "succeeded", output }),
            fail: () =>
              resolve({
                status: "failed",
                cause: "retry",
                failureClass: "transient_infra",
              }),
          };
          const waiter = waiters.shift();
          if (waiter === undefined) queued.push(start);
          else waiter(start);
        });
      },
    },
    next() {
      const start = queued.shift();
      return start === undefined
        ? new Promise((resolve) => waiters.push(resolve))
        : Promise.resolve(start);
    },
  };
}

async function kinds(handle: RunHandle): Promise<string[]> {
  const result: string[] = [];
  for await (const event of handle.events) result.push(event.kind);
  return result;
}

describe("scheduler resources", () => {
  test("never exceeds capacity and identifies resource contention", async () => {
    const executor = controlled();
    const handle = createEngine({
      store: createMemoryStore(),
      registry: createExecutorRegistry([executor.definition]),
      maxConcurrency: 3,
    }).run(
      graph({
        a: { executor: "controlled", resources: ["shared"] },
        b: { executor: "controlled", resources: ["shared"] },
        free: { executor: "controlled" },
      }),
    );

    const a = await executor.next();
    const free = await executor.next();
    expect([a.nodeId, free.nodeId]).toEqual(["a", "free"]);
    free.succeed();
    a.succeed("done");
    const b = await executor.next();
    expect(b.nodeId).toBe("b");
    b.succeed();

    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "done",
    });
    expect(await kinds(handle)).toContain("node_resource_wait");
  });

  test("releases capacity during retry backoff and reacquires it", async () => {
    const executor = controlled();
    const clock = createManualClock();
    const handle = createEngine({
      store: createMemoryStore(),
      registry: createExecutorRegistry([executor.definition]),
      maxConcurrency: 2,
      clock,
      retryPolicy: {
        maxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 10,
        retryableClasses: new Set(["transient_infra"]),
      },
    }).run(
      graph({
        a: { executor: "controlled", resources: ["shared"] },
        b: { executor: "controlled", resources: ["shared"] },
      }),
    );

    const firstA = await executor.next();
    firstA.fail();
    const b = await executor.next();
    expect(b.nodeId).toBe("b");
    b.succeed();
    clock.advance(10);
    const secondA = await executor.next();
    expect(secondA).toMatchObject({ nodeId: "a", attempt: 2 });
    secondA.succeed("done");
    await expect(handle.result).resolves.toEqual({
      status: "succeeded",
      output: "done",
    });
  });

  test("cancellation clears a resource holder and cancels its waiters", async () => {
    const executor = controlled();
    const handle = createEngine({
      store: createMemoryStore(),
      registry: createExecutorRegistry([executor.definition]),
      maxConcurrency: 2,
    }).run(
      graph({
        a: { executor: "controlled", resources: ["shared"] },
        b: { executor: "controlled", resources: ["shared"] },
      }),
    );

    const a = await executor.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancellation = handle.cancel("stop");
    expect(a.signal.aborted).toBe(true);
    a.succeed();
    await cancellation;

    await expect(handle.result).resolves.toEqual({
      status: "cancelled",
      reason: "stop",
      failures: [],
    });
    expect(await kinds(handle)).toEqual(
      expect.arrayContaining(["node_resource_wait", "node_cancelled"]),
    );
  });
});
