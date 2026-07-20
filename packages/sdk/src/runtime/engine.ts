import type { CompiledGraph, CompiledNode } from "../graph/types.js";
import type { PersistedRunEvent, RunEvent } from "./events.js";
import { normalizeThrownCause } from "./failures.js";
import type {
  ExecutionContext,
  ExecutorDefinition,
  ExecutorRegistry,
  NodeExecutionOutcome,
  RunStore,
} from "./ports.js";
import { reduceNodeState } from "./transitions.js";
import type { NodeFailure, NodeState, RunOutcome } from "./types.js";

export interface EngineOptions {
  readonly store: RunStore;
  readonly registry: ExecutorRegistry;
  /**
   * Maximum nodes executing at once. Integer >= 1; invalid values throw
   * from createEngine (API misuse). Default 1 — deterministic by default,
   * opt into parallelism.
   */
  readonly maxConcurrency?: number;
}

export interface RunOptions {
  /** Caller-chosen run id; defaults to a per-engine deterministic counter. */
  readonly runId?: string;
}

/**
 * Callers may await `result`, iterate `events`, do both, or neither —
 * the engine must not care. `events` is a fresh cursor over the
 * persisted log on every iteration (late subscribers get full history,
 * and iterating twice works). `result` resolves for every expected
 * outcome — it rejects only for engine bugs or invalid API use.
 */
export interface RunHandle {
  readonly id: string;
  readonly events: AsyncIterable<PersistedRunEvent>;
  readonly result: Promise<RunOutcome>;
}

export interface Engine {
  run(graph: CompiledGraph, options?: RunOptions): RunHandle;
}

interface NodeCompletion {
  readonly nodeId: string;
  readonly outcome: NodeExecutionOutcome;
}

function getNode(graph: CompiledGraph, nodeId: string): CompiledNode {
  const node = graph.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`compiled graph is missing node "${nodeId}"`);
  }
  return node;
}

function createEventIterable(
  store: RunStore,
  runId: string,
  creation: Promise<void>,
): AsyncIterable<PersistedRunEvent> {
  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<PersistedRunEvent> {
      return (async function* readRunEvents() {
        await creation;
        for await (const event of store.readEvents(runId)) {
          yield event;
        }
      })();
    },
  });
}

async function invokeExecutor(
  node: CompiledNode,
  executor: ExecutorDefinition,
  outputs: ReadonlyMap<string, unknown>,
): Promise<NodeCompletion> {
  const inputs = Object.freeze(
    node.dependsOn.map((dependencyId) => {
      if (!outputs.has(dependencyId)) {
        throw new Error(
          `node "${node.id}" is missing output from dependency "${dependencyId}"`,
        );
      }
      return outputs.get(dependencyId);
    }),
  );
  const context: ExecutionContext = Object.freeze(
    node.config === undefined
      ? { nodeId: node.id, inputs }
      : { nodeId: node.id, inputs, config: node.config },
  );

  try {
    return {
      nodeId: node.id,
      outcome: await executor.execute(context),
    };
  } catch (thrown: unknown) {
    return {
      nodeId: node.id,
      outcome: {
        status: "failed",
        cause: normalizeThrownCause(thrown),
      },
    };
  }
}

async function executeCreatedRun(
  graph: CompiledGraph,
  runId: string,
  store: RunStore,
  registry: ExecutorRegistry,
  maxConcurrency: number,
): Promise<RunOutcome> {
  const executors = new Map<string, ExecutorDefinition>();
  const preflightFailures: NodeFailure[] = [];

  for (const nodeId of graph.order) {
    const node = getNode(graph, nodeId);
    const executor = registry.get(node.executor);
    if (executor === undefined) {
      preflightFailures.push({
        nodeId,
        cause: { code: "UNKNOWN_EXECUTOR", executor: node.executor },
      });
    } else {
      executors.set(nodeId, executor);
    }
  }

  if (preflightFailures.length > 0) {
    return { status: "failed", failures: preflightFailures };
  }

  const states = new Map<string, NodeState>();
  const outputs = new Map<string, unknown>();
  const originatingFailures = new Map<string, NodeFailure>();
  const inFlight = new Map<string, Promise<NodeCompletion>>();

  for (const nodeId of graph.order) {
    states.set(nodeId, "pending");
  }

  async function applyEvents(events: readonly RunEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const stagedStates = new Map<string, NodeState>();
    for (const event of events) {
      const previous =
        stagedStates.get(event.nodeId) ?? states.get(event.nodeId);
      if (previous === undefined) {
        throw new Error(`event targets unknown node "${event.nodeId}"`);
      }
      stagedStates.set(event.nodeId, reduceNodeState(previous, event));
    }

    await store.appendEvents(runId, events);
    for (const [nodeId, state] of stagedStates) {
      states.set(nodeId, state);
    }
  }

  async function promoteReadyNodes(): Promise<void> {
    const events: RunEvent[] = [];
    for (const nodeId of graph.order) {
      if (states.get(nodeId) !== "pending") {
        continue;
      }

      const node = getNode(graph, nodeId);
      if (
        node.dependsOn.every(
          (dependencyId) => states.get(dependencyId) === "succeeded",
        )
      ) {
        events.push({ kind: "node_ready", nodeId });
      }
    }
    await applyEvents(events);
  }

  async function propagateBlockedNodes(): Promise<void> {
    while (true) {
      const events: RunEvent[] = [];
      for (const nodeId of graph.order) {
        if (states.get(nodeId) !== "pending") {
          continue;
        }

        const node = getNode(graph, nodeId);
        const blockedBy = node.dependsOn.filter((dependencyId) => {
          const dependencyState = states.get(dependencyId);
          return dependencyState === "failed" || dependencyState === "blocked";
        });
        if (blockedBy.length > 0) {
          events.push({ kind: "node_blocked", nodeId, blockedBy });
        }
      }

      if (events.length === 0) {
        return;
      }
      await applyEvents(events);
    }
  }

  async function dispatchReadyNodes(): Promise<void> {
    while (inFlight.size < maxConcurrency) {
      const nodeId = graph.order.find(
        (candidateId) => states.get(candidateId) === "ready",
      );
      if (nodeId === undefined) {
        return;
      }

      await applyEvents([{ kind: "node_started", nodeId }]);
      const executor = executors.get(nodeId);
      if (executor === undefined) {
        throw new Error(`preflight lost executor for node "${nodeId}"`);
      }
      inFlight.set(
        nodeId,
        invokeExecutor(getNode(graph, nodeId), executor, outputs),
      );
    }
  }

  const rootEvents: RunEvent[] = [];
  for (const nodeId of graph.order) {
    if (getNode(graph, nodeId).dependsOn.length === 0) {
      rootEvents.push({ kind: "node_ready", nodeId });
    }
  }
  await applyEvents(rootEvents);

  while (true) {
    await dispatchReadyNodes();
    if (inFlight.size === 0) {
      break;
    }

    const completion = await Promise.race(inFlight.values());
    if (!inFlight.delete(completion.nodeId)) {
      throw new Error(
        `completion targets node that is not running: "${completion.nodeId}"`,
      );
    }

    switch (completion.outcome.status) {
      case "succeeded": {
        await applyEvents([
          {
            kind: "node_succeeded",
            nodeId: completion.nodeId,
            output: completion.outcome.output,
          },
        ]);
        outputs.set(completion.nodeId, completion.outcome.output);
        await promoteReadyNodes();
        break;
      }

      case "failed": {
        const failure: NodeFailure = {
          nodeId: completion.nodeId,
          cause: completion.outcome.cause,
        };
        await applyEvents([
          {
            kind: "node_failed",
            nodeId: completion.nodeId,
            failure,
          },
        ]);
        originatingFailures.set(completion.nodeId, failure);
        await propagateBlockedNodes();
        break;
      }

      default: {
        const unhandledOutcome: never = completion.outcome;
        throw new Error(
          `executor for node "${completion.nodeId}" returned an invalid outcome`,
          { cause: unhandledOutcome },
        );
      }
    }
  }

  for (const [nodeId, state] of states) {
    if (state !== "succeeded" && state !== "failed" && state !== "blocked") {
      throw new Error(`run stopped with node "${nodeId}" in state "${state}"`);
    }
  }

  const failures = graph.order.flatMap((nodeId) => {
    const failure = originatingFailures.get(nodeId);
    return failure === undefined ? [] : [failure];
  });
  if (failures.length > 0) {
    return { status: "failed", failures };
  }

  if (!outputs.has(graph.finalNode)) {
    throw new Error(`final node "${graph.finalNode}" has no output`);
  }
  return { status: "succeeded", output: outputs.get(graph.finalNode) };
}

/**
 * The scheduler (plan §5). The whole algorithm:
 * initialize -> promote roots to ready -> pick ready nodes in stable
 * topo order -> run up to N at once -> apply completions through the
 * reducer, promote dependents -> terminal when nothing is running and
 * nothing can become ready.
 *
 * Implementation checklist, in order:
 *
 * 1. Validate maxConcurrency (integer >= 1): throw from createEngine.
 * 2. run(): id = options.runId ?? next per-engine counter ("run-1", ...).
 *    Kick off the async body; return the handle synchronously.
 * 3. store.createRun({ runId, graph }) first — then PREFLIGHT: every
 *    node's executor name resolved against the registry. Any miss ->
 *    outcome failed with one failure per missing executor
 *    ({ code: "UNKNOWN_EXECUTOR", executor } as the cause), finishRun,
 *    resolve result. No node events at all — the run never began.
 * 4. State: Map<nodeId, NodeState> (all pending), Map<nodeId, output>.
 *    ALL state movement goes through reduceNodeState — the engine emits
 *    events and applies them; it never assigns states directly. Persist
 *    every emitted event batch via store.appendEvents.
 * 5. Initial promotion: node_ready for every dependency-free node, in
 *    stable (compiled.order) order.
 * 6. Dispatch loop: while slots are free, take the first ready node in
 *    compiled.order; emit node_started; call the executor with
 *    { nodeId, inputs: dependsOn.map(outputs), config? }. Wrap the call:
 *    await it (executors may return sync or async), catch anything
 *    thrown/rejected and turn it into a failed outcome via
 *    normalizeThrownCause. Track in-flight work as promises resolving to
 *    { nodeId, outcome }; wait for completions with Promise.race.
 * 7. On success: node_succeeded { output }; record the output; every
 *    dependent whose dependencies are now ALL succeeded -> node_ready.
 * 8. On failure: node_failed with { nodeId, cause }; record it as an
 *    ORIGINATING failure. Then propagate: any pending node with at
 *    least one failed-or-blocked direct dependency -> node_blocked with
 *    blockedBy = those direct dependencies (transitively, so a chain
 *    behind a failure becomes blocked step by step; blockedBy names
 *    direct deps, not the root cause).
 * 9. Terminal when nothing is running and nothing is ready. Outcome:
 *    any originating failures -> { status: "failed", failures } (stable
 *    order, originating only — blocked nodes are visible as states, not
 *    failures). Otherwise { status: "succeeded", output } where output
 *    is the finalNode's recorded output.
 * 10. finishRun, resolve result. Engine bugs (IllegalTransitionError,
 *     store rejections) reject result — expected failures never do.
 * 11. handle.events: each [Symbol.asyncIterator]() opens a fresh
 *     store.readEvents(runId) cursor. The engine never blocks on event
 *     consumers, and result must resolve even if nobody reads events.
 */
export function createEngine(options: EngineOptions): Engine {
  const maxConcurrency = options.maxConcurrency ?? 1;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(
      "maxConcurrency must be an integer greater than or equal to 1",
    );
  }

  const { store, registry } = options;
  let nextRunNumber = 1;

  return Object.freeze({
    run(graph: CompiledGraph, runOptions?: RunOptions): RunHandle {
      const runId = runOptions?.runId ?? `run-${String(nextRunNumber++)}`;
      const creation = Promise.resolve().then(() =>
        store.createRun({ runId, graph }),
      );
      const result = (async (): Promise<RunOutcome> => {
        await creation;
        try {
          return await executeCreatedRun(
            graph,
            runId,
            store,
            registry,
            maxConcurrency,
          );
        } finally {
          await store.finishRun(runId);
        }
      })();

      // Keep engine bugs observable through `result` without producing an
      // unhandled rejection when a caller intentionally consumes only events.
      void result.catch(() => undefined);

      return Object.freeze({
        id: runId,
        events: createEventIterable(store, runId, creation),
        result,
      });
    },
  });
}
