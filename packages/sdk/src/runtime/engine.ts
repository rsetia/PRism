import type { CompiledGraph, CompiledNode, JsonValue } from "../graph/types.js";
import {
  snapshotJsonValue,
  snapshotNodeFailure,
} from "../internal/persistence.js";
import type { PersistedRunEvent, RunEvent } from "./events.js";
import { normalizeThrownCause } from "./failures.js";
import type {
  Clock,
  ExecutionContext,
  ExecutorDefinition,
  ExecutorRegistry,
  NodeExecutionOutcome,
  RunStore,
} from "./ports.js";
import {
  computeBackoffMs,
  isRetryable,
  NO_RETRIES,
  resolveFailureClass,
  type RetryPolicy,
} from "./retry.js";
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
  /**
   * After cancel() aborts a running node's signal, wait at most this many
   * milliseconds for its executor to settle before emitting node_cancelled
   * and abandoning the promise (observed, never unhandled). Default:
   * wait forever — purely cooperative. In-process "forced termination"
   * means the engine stops waiting; real process kills arrive with the
   * subprocess backend (plan §14).
   */
  readonly cancelGracePeriodMs?: number;
  /**
   * Retry behavior for failed nodes. Defaults to NO_RETRIES — one
   * attempt per node, which is exactly the pre-§11 behavior.
   */
  readonly retryPolicy?: RetryPolicy;
  /**
   * Time source for retry backoff. Required once a policy actually
   * retries; tests pass a manual clock so backoff is instant.
   */
  readonly clock?: Clock;
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
  /**
   * Request cancellation. Resolves once the run is terminal. Idempotent;
   * a no-op after the run has already completed (the existing outcome
   * stands). `reason` lands in the cancelled outcome (null when omitted).
   */
  readonly cancel: (reason?: JsonValue) => Promise<void>;
}

export interface Engine {
  run(graph: CompiledGraph, options?: RunOptions): RunHandle;
  /**
   * Continue an interrupted run from the store (plan §12). Replays the
   * run's persisted events to rebuild state, reclassifies any node left
   * `running` at crash time as a `transient_infra` failure (so the retry
   * policy can re-run it), then drives the run to completion. The graph
   * comes from the stored snapshot, not the caller. Rejects for an
   * unknown run; a run already finished resolves to its recorded outcome
   * without re-running anything.
   */
  resume(runId: string): RunHandle;
}

interface NodeCompletion {
  readonly kind: "node_completion";
  readonly nodeId: string;
  readonly outcome: NodeExecutionOutcome;
}

interface CancellationRequest {
  readonly kind: "cancellation_requested";
  readonly reason: JsonValue;
}

interface CancellationTimeout {
  readonly kind: "cancellation_timeout";
  readonly nodeId: string;
}

interface RetryReady {
  readonly kind: "retry_ready";
  readonly nodeId: string;
}

interface RetryCancelled {
  readonly kind: "retry_cancelled";
  readonly nodeId: string;
}

type SchedulerEvent =
  | NodeCompletion
  | CancellationRequest
  | CancellationTimeout
  | RetryReady
  | RetryCancelled;

interface CancellationControl {
  readonly requested: Promise<CancellationRequest>;
  readonly isRequested: () => boolean;
  readonly request: (reason: JsonValue) => void;
  readonly register: (nodeId: string, controller: AbortController) => void;
  readonly remove: (nodeId: string) => void;
  readonly markTerminal: () => void;
}

function createCancellationControl(): CancellationControl {
  const controllers = new Map<string, AbortController>();
  let acceptedRequest: CancellationRequest | undefined;
  let terminal = false;
  let resolveRequest: ((request: CancellationRequest) => void) | undefined;
  const requested = new Promise<CancellationRequest>((resolve) => {
    resolveRequest = resolve;
  });

  return {
    requested,
    isRequested: () => acceptedRequest !== undefined,
    request(reason: JsonValue): void {
      if (terminal || acceptedRequest !== undefined) {
        return;
      }

      const request: CancellationRequest = {
        kind: "cancellation_requested",
        reason,
      };
      acceptedRequest = request;
      resolveRequest?.(request);
      for (const controller of controllers.values()) {
        controller.abort(reason);
      }
    },
    register(nodeId: string, controller: AbortController): void {
      controllers.set(nodeId, controller);
      if (acceptedRequest !== undefined) {
        controller.abort(acceptedRequest.reason);
      }
    },
    remove(nodeId: string): void {
      controllers.delete(nodeId);
    },
    markTerminal(): void {
      terminal = true;
      controllers.clear();
    },
  };
}

function withCancellationGrace(
  settlement: Promise<SchedulerEvent>,
  nodeId: string,
  gracePeriodMs: number,
): Promise<SchedulerEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CancellationTimeout>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "cancellation_timeout", nodeId });
    }, gracePeriodMs);
  });

  return Promise.race([settlement, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function waitForRetry(
  clock: Clock,
  delayMs: number,
  nodeId: string,
  signal: AbortSignal,
): Promise<SchedulerEvent> {
  try {
    await clock.wait(delayMs, signal);
    return { kind: "retry_ready", nodeId };
  } catch (error: unknown) {
    if (signal.aborted) {
      return { kind: "retry_cancelled", nodeId };
    }
    throw error;
  }
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
  runId: string,
  node: CompiledNode,
  executor: ExecutorDefinition,
  outputs: ReadonlyMap<string, JsonValue>,
  signal: AbortSignal,
  attempt: number,
  reportPhase: ExecutionContext["reportPhase"],
): Promise<SchedulerEvent> {
  const inputs = Object.freeze(
    node.dependsOn.map((dependencyId) => {
      if (!outputs.has(dependencyId)) {
        throw new Error(
          `node "${node.id}" is missing output from dependency "${dependencyId}"`,
        );
      }
      return outputs.get(dependencyId) as JsonValue;
    }),
  );
  const context: ExecutionContext = Object.freeze(
    node.config === undefined
      ? {
          runId,
          nodeId: node.id,
          kind: node.kind,
          attempt,
          inputs,
          signal,
          reportPhase,
        }
      : {
          runId,
          nodeId: node.id,
          kind: node.kind,
          attempt,
          inputs,
          config: node.config,
          signal,
          reportPhase,
        },
  );

  try {
    const outcome: unknown = await executor.execute(context);
    return {
      kind: "node_completion",
      nodeId: node.id,
      outcome: normalizeExecutorOutcome(node.id, outcome),
    };
  } catch (thrown: unknown) {
    return {
      kind: "node_completion",
      nodeId: node.id,
      outcome: {
        status: "failed",
        cause: normalizeThrownCause(thrown),
      },
    };
  }
}

function normalizeExecutorOutcome(
  nodeId: string,
  outcome: unknown,
): NodeExecutionOutcome {
  if (
    typeof outcome !== "object" ||
    outcome === null ||
    Array.isArray(outcome)
  ) {
    return invalidExecutorOutcome(
      "INVALID_EXECUTOR_OUTCOME",
      "executor must return an outcome object",
    );
  }
  const value = outcome as Record<string, unknown>;
  if (value["status"] === "succeeded") {
    if (!Object.hasOwn(value, "output")) {
      return invalidExecutorOutcome(
        "INVALID_EXECUTOR_OUTPUT",
        "succeeded executor outcome must contain output",
      );
    }
    try {
      return {
        status: "succeeded",
        output: snapshotJsonValue(value["output"], "executor output"),
      };
    } catch (error: unknown) {
      return invalidExecutorOutcome(
        "INVALID_EXECUTOR_OUTPUT",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (value["status"] === "failed") {
    try {
      const failure = snapshotNodeFailure({
        nodeId,
        cause: value["cause"],
        ...(value["failureClass"] === undefined
          ? {}
          : { failureClass: value["failureClass"] }),
      });
      return failure.failureClass === undefined
        ? { status: "failed", cause: failure.cause }
        : {
            status: "failed",
            cause: failure.cause,
            failureClass: failure.failureClass,
          };
    } catch (error: unknown) {
      return invalidExecutorOutcome(
        "INVALID_EXECUTOR_FAILURE",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return invalidExecutorOutcome(
    "INVALID_EXECUTOR_OUTCOME",
    'executor outcome status must be "succeeded" or "failed"',
  );
}

function invalidExecutorOutcome(
  code: string,
  message: string,
): NodeExecutionOutcome {
  return {
    status: "failed",
    cause: { code, message },
    failureClass: "validation_failed",
  };
}

interface RunExecutionState {
  readonly states: Map<string, NodeState>;
  readonly attempts: Map<string, number>;
  readonly outputs: Map<string, JsonValue>;
  readonly originatingFailures: Map<string, NodeFailure>;
  readonly retryDelays: Map<string, number>;
  readonly hasCancelledNodes: boolean;
}

function createInitialExecutionState(graph: CompiledGraph): RunExecutionState {
  const states = new Map<string, NodeState>();
  const attempts = new Map<string, number>();
  for (const nodeId of graph.order) {
    states.set(nodeId, "pending");
    attempts.set(nodeId, 0);
  }
  return {
    states,
    attempts,
    outputs: new Map(),
    originatingFailures: new Map(),
    retryDelays: new Map(),
    hasCancelledNodes: false,
  };
}

function replayExecutionState(
  graph: CompiledGraph,
  events: readonly PersistedRunEvent[],
): RunExecutionState {
  const initial = createInitialExecutionState(graph);
  const cancelledNodes = new Set<string>();

  for (const event of events) {
    const previous = initial.states.get(event.nodeId);
    if (previous === undefined) {
      throw new Error(`stored event targets unknown node "${event.nodeId}"`);
    }
    initial.states.set(event.nodeId, reduceNodeState(previous, event));

    switch (event.kind) {
      case "node_started":
        initial.attempts.set(
          event.nodeId,
          (initial.attempts.get(event.nodeId) ?? 0) + 1,
        );
        break;
      case "node_phase_changed":
        break;
      case "node_succeeded":
        initial.outputs.set(event.nodeId, event.output);
        break;
      case "node_failed":
        initial.originatingFailures.set(event.nodeId, event.failure);
        break;
      case "node_retry_wait":
        initial.retryDelays.set(event.nodeId, event.delayMs);
        break;
      case "node_cancelled":
        cancelledNodes.add(event.nodeId);
        break;
      case "node_reset":
        // Administrative reset wipes the node's accumulated history so a
        // resume re-runs it fresh — attempts, output, failure, backoff,
        // and any prior cancellation.
        initial.attempts.delete(event.nodeId);
        initial.outputs.delete(event.nodeId);
        initial.originatingFailures.delete(event.nodeId);
        initial.retryDelays.delete(event.nodeId);
        cancelledNodes.delete(event.nodeId);
        break;
      case "node_ready":
      case "node_blocked":
      case "node_cancelling":
        break;
      default: {
        const unhandledEvent: never = event;
        throw new Error(
          `unhandled stored event: ${JSON.stringify(unhandledEvent)}`,
        );
      }
    }
  }

  return { ...initial, hasCancelledNodes: cancelledNodes.size > 0 };
}

async function readEventSnapshot(
  store: RunStore,
  runId: string,
  revision: number,
): Promise<readonly PersistedRunEvent[]> {
  const iterator = store.readEvents(runId)[Symbol.asyncIterator]();
  const events: PersistedRunEvent[] = [];
  try {
    for (let sequence = 0; sequence < revision; sequence += 1) {
      const next = await iterator.next();
      if (next.done) {
        throw new Error(
          `run "${runId}" ended before event sequence ${String(sequence)}`,
        );
      }
      if (next.value.seq !== sequence) {
        throw new Error(
          `run "${runId}" expected event sequence ${String(sequence)}, received ${String(next.value.seq)}`,
        );
      }
      events.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  return Object.freeze(events);
}

async function executeRun(
  graph: CompiledGraph,
  runId: string,
  store: RunStore,
  registry: ExecutorRegistry,
  maxConcurrency: number,
  cancelGracePeriodMs: number | undefined,
  cancellation: CancellationControl,
  retryPolicy: RetryPolicy,
  clock: Clock | undefined,
  initialState?: RunExecutionState,
  initialRevision = 0,
): Promise<RunOutcome> {
  const executors = new Map<string, ExecutorDefinition>();
  const preflightFailures: NodeFailure[] = [];

  for (const nodeId of graph.order) {
    const node = getNode(graph, nodeId);
    const resumedState = initialState?.states.get(nodeId);
    if (
      resumedState === "succeeded" ||
      resumedState === "failed" ||
      resumedState === "blocked" ||
      resumedState === "cancelled"
    ) {
      continue;
    }
    const executor = registry.get(node.executor);
    if (executor === undefined) {
      preflightFailures.push({
        nodeId,
        cause: { code: "UNKNOWN_EXECUTOR", executor: node.executor },
      });
    } else {
      try {
        executor.validateConfig?.(node.config);
        executors.set(nodeId, executor);
      } catch (error: unknown) {
        preflightFailures.push({
          nodeId,
          cause: {
            code: "INVALID_CONFIG",
            executor: node.executor,
            message: error instanceof Error ? error.message : String(error),
          },
          failureClass: "validation_failed",
        });
      }
    }
  }

  if (preflightFailures.length > 0) {
    return { status: "failed", failures: preflightFailures };
  }

  const execution = initialState ?? createInitialExecutionState(graph);
  const { states, attempts, outputs, originatingFailures, retryDelays } =
    execution;
  const inFlight = new Map<string, Promise<SchedulerEvent>>();
  let cancellationObserved = false;
  let cancellationAccepted = execution.hasCancelledNodes;
  let cancellationReason: JsonValue = null;
  let revision = initialRevision;
  let appendTail = Promise.resolve();

  function applyEvents(events: readonly RunEvent[]): Promise<void> {
    if (events.length === 0) {
      return Promise.resolve();
    }

    const append = appendTail.then(async () => {
      const stagedStates = new Map<string, NodeState>();
      const persistable: RunEvent[] = [];
      for (const event of events) {
        const previous =
          stagedStates.get(event.nodeId) ?? states.get(event.nodeId);
        if (previous === undefined) {
          throw new Error(`event targets unknown node "${event.nodeId}"`);
        }
        // A phase report can arrive from an executor the engine has already
        // abandoned (cancellation grace timeout) — by then the node is
        // terminal. Dropping it here, inside the serialized append chain,
        // is the only race-free place to make that call.
        if (
          event.kind === "node_phase_changed" &&
          previous !== "running" &&
          previous !== "cancelling"
        ) {
          continue;
        }
        stagedStates.set(event.nodeId, reduceNodeState(previous, event));
        persistable.push(event);
      }
      if (persistable.length === 0) {
        return;
      }

      const persisted = await store.appendEvents(runId, persistable, revision);
      if (persisted.length !== persistable.length) {
        throw new Error("store persisted a different number of events");
      }
      for (let index = 0; index < persisted.length; index += 1) {
        if (persisted[index]?.seq !== revision + index) {
          throw new Error("store returned a non-gapless event sequence");
        }
      }
      revision += persisted.length;
      for (const [nodeId, state] of stagedStates) {
        states.set(nodeId, state);
      }
    });
    // The chain must survive a rejected append: the failure belongs to this
    // caller alone, not to every append that comes after it.
    appendTail = append.then(
      () => undefined,
      () => undefined,
    );
    return append;
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

  function startRetryTimer(nodeId: string, delayMs: number): void {
    if (clock === undefined) {
      throw new Error("clock is required when retryPolicy schedules a retry");
    }
    const controller = new AbortController();
    cancellation.register(nodeId, controller);
    inFlight.set(
      nodeId,
      waitForRetry(clock, delayMs, nodeId, controller.signal),
    );
  }

  async function processNodeFailure(
    nodeId: string,
    failed: {
      readonly cause: JsonValue;
      readonly failureClass?: NodeFailure["failureClass"];
    },
  ): Promise<void> {
    const failure: NodeFailure =
      failed.failureClass === undefined
        ? { nodeId, cause: failed.cause }
        : { nodeId, cause: failed.cause, failureClass: failed.failureClass };
    const attempt = attempts.get(nodeId);
    if (attempt === undefined || attempt < 1) {
      throw new Error(`node "${nodeId}" failed without a recorded attempt`);
    }

    if (
      attempt < retryPolicy.maxAttempts &&
      isRetryable(retryPolicy, resolveFailureClass(failure))
    ) {
      const delayMs = computeBackoffMs(retryPolicy, attempt);
      // Validate the required adapter before persisting retry_wait, so an
      // API configuration error does not strand a durable run in that state.
      if (clock === undefined) {
        throw new Error("clock is required when retryPolicy schedules a retry");
      }
      await applyEvents([
        {
          kind: "node_retry_wait",
          nodeId,
          attempt,
          delayMs,
          failure,
        },
      ]);
      retryDelays.set(nodeId, delayMs);
      startRetryTimer(nodeId, delayMs);
      return;
    }

    await applyEvents([{ kind: "node_failed", nodeId, failure }]);
    retryDelays.delete(nodeId);
    originatingFailures.set(nodeId, failure);
    await propagateBlockedNodes();
  }

  async function dispatchReadyNodes(): Promise<void> {
    const runningCount = (): number =>
      [...states.values()].filter((state) => state === "running").length;

    while (runningCount() < maxConcurrency && !cancellation.isRequested()) {
      const nodeId = graph.order.find(
        (candidateId) => states.get(candidateId) === "ready",
      );
      if (nodeId === undefined) {
        return;
      }

      await applyEvents([{ kind: "node_started", nodeId }]);
      const attempt = (attempts.get(nodeId) ?? 0) + 1;
      attempts.set(nodeId, attempt);
      if (cancellation.isRequested()) {
        return;
      }
      const executor = executors.get(nodeId);
      if (executor === undefined) {
        throw new Error(`preflight lost executor for node "${nodeId}"`);
      }
      const controller = new AbortController();
      cancellation.register(nodeId, controller);
      inFlight.set(
        nodeId,
        invokeExecutor(
          runId,
          getNode(graph, nodeId),
          executor,
          outputs,
          controller.signal,
          attempt,
          (phase) =>
            applyEvents([{ kind: "node_phase_changed", nodeId, phase }]),
        ),
      );
    }
  }

  async function acceptCancellation(
    request: CancellationRequest,
  ): Promise<boolean> {
    const events: RunEvent[] = [];
    const runningNodeIds: string[] = [];
    const retryWaitingNodeIds: string[] = [];

    for (const nodeId of graph.order) {
      const state = states.get(nodeId);
      if (state === "pending" || state === "ready" || state === "retry_wait") {
        events.push({ kind: "node_cancelled", nodeId });
        if (state === "retry_wait") {
          retryWaitingNodeIds.push(nodeId);
        }
      } else if (state === "running") {
        events.push({ kind: "node_cancelling", nodeId });
        runningNodeIds.push(nodeId);
      }
    }

    // Every node is already terminal: its persisted completion won.
    if (events.length === 0) {
      return false;
    }

    await applyEvents(events);

    for (const nodeId of retryWaitingNodeIds) {
      inFlight.delete(nodeId);
      cancellation.remove(nodeId);
    }

    const immediatelyCancelled: RunEvent[] = [];
    for (const nodeId of runningNodeIds) {
      const settlement = inFlight.get(nodeId);
      if (settlement === undefined) {
        // Cancellation landed in the narrow window after node_started was
        // persisted but before the executor was invoked.
        immediatelyCancelled.push({ kind: "node_cancelled", nodeId });
        cancellation.remove(nodeId);
      } else if (cancelGracePeriodMs !== undefined) {
        inFlight.set(
          nodeId,
          withCancellationGrace(settlement, nodeId, cancelGracePeriodMs),
        );
      }
    }
    await applyEvents(immediatelyCancelled);

    cancellationReason = request.reason;
    return true;
  }

  if (initialState !== undefined) {
    for (const nodeId of graph.order) {
      const state = states.get(nodeId);
      if (state === "running" || state === "cancelling") {
        await processNodeFailure(nodeId, {
          cause: { code: "INTERRUPTED" },
          failureClass: "transient_infra",
        });
      }
    }

    for (const nodeId of graph.order) {
      if (states.get(nodeId) !== "retry_wait") {
        continue;
      }
      const delayMs = retryDelays.get(nodeId);
      if (delayMs === undefined) {
        throw new Error(
          `node "${nodeId}" is retry_wait without a stored retry delay`,
        );
      }
      startRetryTimer(nodeId, delayMs);
    }
  }

  await propagateBlockedNodes();
  await promoteReadyNodes();

  while (true) {
    if (!cancellation.isRequested()) {
      await dispatchReadyNodes();
    }

    if (
      inFlight.size === 0 &&
      (!cancellation.isRequested() || cancellationObserved)
    ) {
      break;
    }

    const candidates = [...inFlight.values()];
    if (!cancellationObserved) {
      candidates.push(cancellation.requested);
    }
    if (candidates.length === 0) {
      break;
    }

    const schedulerEvent = await Promise.race(candidates);
    if (schedulerEvent.kind === "cancellation_requested") {
      cancellationObserved = true;
      cancellationAccepted = await acceptCancellation(schedulerEvent);
      continue;
    }

    if (!inFlight.delete(schedulerEvent.nodeId)) {
      throw new Error(
        `settlement targets node that is not running: "${schedulerEvent.nodeId}"`,
      );
    }
    cancellation.remove(schedulerEvent.nodeId);

    const state = states.get(schedulerEvent.nodeId);
    if (state === undefined) {
      throw new Error(
        `settlement targets unknown node "${schedulerEvent.nodeId}"`,
      );
    }

    if (schedulerEvent.kind === "retry_cancelled") {
      if (!cancellation.isRequested()) {
        throw new Error(
          `retry timer for node "${schedulerEvent.nodeId}" was cancelled without a run cancellation`,
        );
      }
      if (!cancellationObserved) {
        cancellationObserved = true;
        cancellationAccepted = await acceptCancellation(
          await cancellation.requested,
        );
      }
      continue;
    }

    if (schedulerEvent.kind === "retry_ready") {
      if (state !== "retry_wait") {
        throw new Error(
          `retry timer for node "${schedulerEvent.nodeId}" settled in state "${state}"`,
        );
      }
      await applyEvents([
        { kind: "node_ready", nodeId: schedulerEvent.nodeId },
      ]);
      retryDelays.delete(schedulerEvent.nodeId);
      continue;
    }

    if (state === "cancelling") {
      await applyEvents([
        { kind: "node_cancelled", nodeId: schedulerEvent.nodeId },
      ]);
      continue;
    }
    if (schedulerEvent.kind === "cancellation_timeout") {
      throw new Error(
        `cancellation timeout targeted non-cancelling node "${schedulerEvent.nodeId}"`,
      );
    }
    if (state !== "running") {
      throw new Error(
        `node "${schedulerEvent.nodeId}" settled in state "${state}"`,
      );
    }

    switch (schedulerEvent.outcome.status) {
      case "succeeded": {
        await applyEvents([
          {
            kind: "node_succeeded",
            nodeId: schedulerEvent.nodeId,
            output: schedulerEvent.outcome.output,
          },
        ]);
        outputs.set(schedulerEvent.nodeId, schedulerEvent.outcome.output);
        await promoteReadyNodes();
        break;
      }

      case "failed": {
        await processNodeFailure(schedulerEvent.nodeId, schedulerEvent.outcome);
        break;
      }

      default: {
        const unhandledOutcome: never = schedulerEvent.outcome;
        throw new Error(
          `executor for node "${schedulerEvent.nodeId}" returned an invalid outcome`,
          { cause: unhandledOutcome },
        );
      }
    }
  }

  for (const [nodeId, state] of states) {
    if (
      state !== "succeeded" &&
      state !== "failed" &&
      state !== "blocked" &&
      state !== "cancelled"
    ) {
      throw new Error(`run stopped with node "${nodeId}" in state "${state}"`);
    }
  }

  const failures = graph.order.flatMap((nodeId) => {
    const failure = originatingFailures.get(nodeId);
    return failure === undefined ? [] : [failure];
  });
  if (cancellationAccepted) {
    return {
      status: "cancelled",
      reason: cancellationReason,
      failures,
    };
  }
  if (failures.length > 0) {
    return { status: "failed", failures };
  }

  if (!outputs.has(graph.finalNode)) {
    throw new Error(`final node "${graph.finalNode}" has no output`);
  }
  return {
    status: "succeeded",
    output: outputs.get(graph.finalNode) as JsonValue,
  };
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
  const cancelGracePeriodMs = options.cancelGracePeriodMs;
  if (
    cancelGracePeriodMs !== undefined &&
    (!Number.isFinite(cancelGracePeriodMs) || cancelGracePeriodMs < 0)
  ) {
    throw new Error(
      "cancelGracePeriodMs must be a finite number greater than or equal to 0",
    );
  }

  const retryPolicy = options.retryPolicy ?? NO_RETRIES;
  if (
    !Number.isInteger(retryPolicy.maxAttempts) ||
    retryPolicy.maxAttempts < 1
  ) {
    throw new Error(
      "retryPolicy.maxAttempts must be an integer greater than or equal to 1",
    );
  }
  if (
    !Number.isFinite(retryPolicy.baseDelayMs) ||
    retryPolicy.baseDelayMs < 0 ||
    !Number.isFinite(retryPolicy.maxDelayMs) ||
    retryPolicy.maxDelayMs < 0
  ) {
    throw new Error(
      "retryPolicy delays must be finite numbers greater than or equal to 0",
    );
  }

  const { store, registry, clock } = options;
  let nextRunNumber = 1;

  function createHandle(
    runId: string,
    ready: Promise<void>,
    result: Promise<RunOutcome>,
    cancellation: CancellationControl,
  ): RunHandle {
    // `ready` also gates event-only consumers; observe its rejection when
    // callers intentionally await only result.
    void ready.catch(() => undefined);
    // Keep engine bugs observable through `result` without producing an
    // unhandled rejection when a caller intentionally consumes only events.
    void result.catch(() => undefined);
    void result.then(
      () => {
        cancellation.markTerminal();
      },
      () => {
        cancellation.markTerminal();
      },
    );
    const cancellationFinished = result.then(() => undefined);
    void cancellationFinished.catch(() => undefined);

    return Object.freeze({
      id: runId,
      events: createEventIterable(store, runId, ready),
      result,
      cancel: (reason?: JsonValue): Promise<void> => {
        let persistedReason: JsonValue;
        try {
          persistedReason = snapshotJsonValue(
            reason ?? null,
            "cancellation reason",
          );
        } catch (error: unknown) {
          return Promise.reject(
            error instanceof Error
              ? error
              : new Error("cancellation reason must be JSON-safe"),
          );
        }
        cancellation.request(persistedReason);
        return cancellationFinished;
      },
    });
  }

  return Object.freeze({
    run(graph: CompiledGraph, runOptions?: RunOptions): RunHandle {
      const runId = runOptions?.runId ?? `run-${String(nextRunNumber++)}`;
      const cancellation = createCancellationControl();
      const creation = Promise.resolve().then(() =>
        store.createRun({ runId, graph }),
      );
      const result = (async (): Promise<RunOutcome> => {
        await creation;
        const outcome = await executeRun(
          graph,
          runId,
          store,
          registry,
          maxConcurrency,
          cancelGracePeriodMs,
          cancellation,
          retryPolicy,
          clock,
        );
        await store.finishRun(runId, outcome);
        return outcome;
      })();
      return createHandle(runId, creation, result, cancellation);
    },

    resume(runId: string): RunHandle {
      const cancellation = createCancellationControl();
      const loading = Promise.resolve().then(async () => {
        const stored = await store.getRun(runId);
        if (stored === undefined) {
          throw new Error(`unknown run: "${runId}"`);
        }
        return stored;
      });
      const ready = loading.then(() => undefined);
      const result = (async (): Promise<RunOutcome> => {
        const stored = await loading;
        const events = await readEventSnapshot(store, runId, stored.revision);
        const execution = replayExecutionState(stored.graph, events);
        if (stored.finished) {
          return stored.outcome;
        }

        const outcome = await executeRun(
          stored.graph,
          runId,
          store,
          registry,
          maxConcurrency,
          cancelGracePeriodMs,
          cancellation,
          retryPolicy,
          clock,
          execution,
          stored.revision,
        );
        await store.finishRun(runId, outcome);
        return outcome;
      })();
      return createHandle(runId, ready, result, cancellation);
    },
  });
}
