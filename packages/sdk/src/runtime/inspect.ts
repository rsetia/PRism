import type { CompiledGraph } from "../graph/types.js";
import type { PersistedRunEvent } from "./events.js";
import type { NodePhase } from "./events.js";
import { reduceNodeState } from "./transitions.js";
import type { Clock, RunStore } from "./ports.js";
import type { NodeFailure, NodeState } from "./types.js";
import { tryParseProofOfWork, type ProofOfWorkV1 } from "./proof-of-work.js";
import type { JsonValue } from "../graph/types.js";

/**
 * A read-only snapshot of a run, rebuilt from its persisted events (plan
 * §16). This is the shared core behind the operator read commands
 * (`inspect`, and later `status`/`watch`): a durable store keeps the
 * events, this folds them back into current node states — the same replay
 * the engine's resume uses, exposed for observation.
 */

export interface NodeInspection {
  readonly nodeId: string;
  readonly state: NodeState;
  /** Null when this node has no events or includes legacy timestamp-free data. */
  readonly timing: NodeTiming | null;
  /** Structured agent evidence; null for generic and legacy outputs. */
  readonly evidence: ProofOfWorkV1 | null;
}

export type NodeTimingPhase =
  | "dependency_wait"
  | "scheduler_queue"
  | "retry_wait"
  | "recovery_wait"
  | NodePhase;

export interface PhaseDuration {
  readonly phase: NodeTimingPhase;
  readonly durationMs: number;
}

export interface NodeTiming {
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly totalDurationMs: number;
  readonly attributedDurationMs: number;
  readonly unattributedDurationMs: number;
  readonly phases: readonly PhaseDuration[];
}

export interface RunInspection {
  readonly runId: string;
  readonly finished: boolean;
  /** Every node in compiled order, with its current state. */
  readonly nodes: readonly NodeInspection[];
  /** Originating failures observed so far. */
  readonly failures: readonly NodeFailure[];
  /** Null for empty or legacy timestamp-free event logs. */
  readonly timing: RunTiming | null;
}

export interface CriticalPathTiming {
  readonly nodeIds: readonly string[];
  readonly durationMs: number;
  readonly phases: readonly PhaseDuration[];
}

export interface RunTiming {
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly totalDurationMs: number;
  /** Coverage across cumulative node wall time, from 0 through 1. */
  readonly attributionCoverage: number;
  /** Cumulative totals across nodes; parallel work may overlap. */
  readonly phases: readonly PhaseDuration[];
  readonly waitingPhases: readonly PhaseDuration[];
  readonly criticalPath: CriticalPathTiming;
}

export interface WatchRunOptions {
  /** Polling time source. Required so SDK watches remain deterministic. */
  readonly clock: Clock;
  /** Delay between snapshots in milliseconds. Default 1000. */
  readonly intervalMs?: number;
  /** Interrupt an in-flight polling wait. */
  readonly signal?: AbortSignal;
}

/**
 * Rebuild a run's current state from the store, without running anything.
 * Works on finished and in-progress runs alike.
 *
 * Implementation:
 * - stored = await store.getRun(runId); reject (throw) if undefined
 *   ("unknown run").
 * - initialize every node in stored.graph.order to "pending".
 * - read a SNAPSHOT, not a live follow: take exactly stored.revision events
 *   from store.readEvents(runId) (the same bounded read resume uses) so an
 *   in-progress run doesn't block waiting for more. Fold each event through
 *   reduceNodeState for its node; collect node_failed events as failures.
 * - return { runId, finished: stored.finished, nodes (in graph order),
 *   failures }.
 * - the reducer throws on an illegal transition — a corrupt/gappy log is a
 *   real error worth surfacing, not swallowing.
 */
export function inspectRun(
  store: RunStore,
  runId: string,
): Promise<RunInspection> {
  return inspectRunSnapshot(store, runId);
}

/**
 * Poll immutable run inspections until the durable run is finished.
 * The first snapshot is immediate; subsequent reads use the Clock port.
 */
export function watchRun(
  store: RunStore,
  runId: string,
  options: WatchRunOptions,
): AsyncIterable<RunInspection> {
  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("watch intervalMs must be a finite number greater than 0");
  }
  return watchRunSnapshots(
    store,
    runId,
    options.clock,
    intervalMs,
    options.signal,
  );
}

async function* watchRunSnapshots(
  store: RunStore,
  runId: string,
  clock: Clock,
  intervalMs: number,
  signal: AbortSignal | undefined,
): AsyncIterable<RunInspection> {
  while (true) {
    const inspection = await inspectRun(store, runId);
    yield inspection;
    if (inspection.finished) {
      return;
    }
    await clock.wait(intervalMs, signal);
  }
}

async function inspectRunSnapshot(
  store: RunStore,
  runId: string,
): Promise<RunInspection> {
  const stored = await store.getRun(runId);
  if (stored === undefined) {
    throw new Error(`unknown run: "${runId}"`);
  }
  if (!Number.isSafeInteger(stored.revision) || stored.revision < 0) {
    throw new Error(
      `run "${runId}" has invalid revision ${String(stored.revision)}`,
    );
  }

  const states = new Map<string, NodeState>();
  for (const nodeId of stored.graph.order) {
    states.set(nodeId, "pending");
  }

  const failureByNode = new Map<string, NodeFailure>();
  const outputByNode = new Map<string, JsonValue>();
  const events = await readEventSnapshot(store, runId, stored.revision);
  const timings = calculateNodeTimings(stored.graph.order, events);
  for (const event of events) {
    const previous = states.get(event.nodeId);
    if (previous === undefined) {
      throw new Error(`stored event targets unknown node "${event.nodeId}"`);
    }
    states.set(event.nodeId, reduceNodeState(previous, event));
    if (event.kind === "node_failed") {
      failureByNode.set(event.nodeId, event.failure);
    } else if (event.kind === "node_succeeded") {
      outputByNode.set(event.nodeId, event.output);
    } else if (event.kind === "node_reset") {
      // An administrative reset drops the node's recorded failure.
      failureByNode.delete(event.nodeId);
      outputByNode.delete(event.nodeId);
    }
  }
  const eventFailures = stored.graph.order.flatMap((nodeId) => {
    const failure = failureByNode.get(nodeId);
    return failure === undefined ? [] : [failure];
  });
  const failures =
    stored.outcome?.status === "failed" ||
    stored.outcome?.status === "cancelled"
      ? stored.outcome.failures
      : eventFailures;

  const nodes = stored.graph.order.map((nodeId) => {
    const state = states.get(nodeId);
    if (state === undefined) {
      throw new Error(`compiled graph order contains unknown node "${nodeId}"`);
    }
    return Object.freeze({
      nodeId,
      state,
      timing: timings.get(nodeId) ?? null,
      evidence: outputByNode.has(nodeId)
        ? tryParseProofOfWork(outputByNode.get(nodeId) as JsonValue)
        : null,
    });
  });
  const timing = calculateRunTiming(
    stored.graph,
    stored.finished,
    events,
    timings,
  );

  return Object.freeze({
    runId,
    finished: stored.finished,
    nodes: Object.freeze(nodes),
    failures: Object.freeze(failures),
    timing,
  });
}

function calculateRunTiming(
  graph: CompiledGraph,
  finished: boolean,
  events: readonly PersistedRunEvent[],
  nodeTimings: ReadonlyMap<string, NodeTiming>,
): RunTiming | null {
  if (
    events.length === 0 ||
    events.some((event) => event.timestampMs === null)
  ) {
    return null;
  }
  // A loop, not Math.min(...spread): a long run's event log can exceed the
  // engine's argument-count limit and throw RangeError.
  let startedAtMs = events[0]?.timestampMs as number;
  let observedAtMs = startedAtMs;
  for (const event of events) {
    const timestampMs = event.timestampMs as number;
    if (timestampMs < startedAtMs) startedAtMs = timestampMs;
    if (timestampMs > observedAtMs) observedAtMs = timestampMs;
  }
  const totalDurationMs = Math.max(0, observedAtMs - startedAtMs);
  const cumulativePhases = sumPhases([...nodeTimings.values()]);
  const cumulativeNodeDurationMs = [...nodeTimings.values()].reduce(
    (total, timing) => total + timing.totalDurationMs,
    0,
  );
  const attributedDurationMs = [...nodeTimings.values()].reduce(
    (total, timing) => total + timing.attributedDurationMs,
    0,
  );
  const criticalPath = calculateCriticalPath(graph, nodeTimings);
  return Object.freeze({
    startedAtMs,
    completedAtMs: finished ? observedAtMs : null,
    totalDurationMs,
    attributionCoverage:
      cumulativeNodeDurationMs === 0
        ? 1
        : Math.min(1, attributedDurationMs / cumulativeNodeDurationMs),
    phases: cumulativePhases,
    waitingPhases: Object.freeze(
      cumulativePhases.filter((phase) => isWaitingPhase(phase.phase)),
    ),
    criticalPath,
  });
}

function calculateCriticalPath(
  graph: CompiledGraph,
  timings: ReadonlyMap<string, NodeTiming>,
): CriticalPathTiming {
  const paths = new Map<
    string,
    { readonly durationMs: number; readonly nodeIds: readonly string[] }
  >();
  for (const nodeId of graph.order) {
    const node = graph.nodes[nodeId];
    const timing = timings.get(nodeId);
    if (node === undefined || timing === undefined) continue;
    const predecessor = node.dependsOn
      .map((dependencyId) => paths.get(dependencyId))
      .filter(
        (
          path,
        ): path is {
          readonly durationMs: number;
          readonly nodeIds: readonly string[];
        } => path !== undefined,
      )
      .sort((left, right) => right.durationMs - left.durationMs)[0];
    const activeDurationMs = timing.phases
      .filter((phase) => phase.phase !== "dependency_wait")
      .reduce((total, phase) => total + phase.durationMs, 0);
    paths.set(nodeId, {
      durationMs: (predecessor?.durationMs ?? 0) + activeDurationMs,
      nodeIds: [...(predecessor?.nodeIds ?? []), nodeId],
    });
  }
  const selected = paths.get(graph.finalNode) ??
    [...paths.values()].sort(
      (left, right) => right.durationMs - left.durationMs,
    )[0] ?? { durationMs: 0, nodeIds: [] };
  const pathTimings = selected.nodeIds.flatMap((nodeId) => {
    const timing = timings.get(nodeId);
    return timing === undefined ? [] : [timing];
  });
  return Object.freeze({
    nodeIds: Object.freeze([...selected.nodeIds]),
    durationMs: selected.durationMs,
    phases: Object.freeze(
      sumPhases(pathTimings).filter(
        (phase) => phase.phase !== "dependency_wait",
      ),
    ),
  });
}

function sumPhases(timings: readonly NodeTiming[]): readonly PhaseDuration[] {
  const totals = new Map<NodeTimingPhase, number>();
  for (const timing of timings) {
    for (const phase of timing.phases) {
      totals.set(
        phase.phase,
        (totals.get(phase.phase) ?? 0) + phase.durationMs,
      );
    }
  }
  return Object.freeze(
    [...totals.entries()]
      .map(([phase, durationMs]) => Object.freeze({ phase, durationMs }))
      .sort(
        (left, right) =>
          right.durationMs - left.durationMs ||
          left.phase.localeCompare(right.phase),
      ),
  );
}

function isWaitingPhase(phase: NodeTimingPhase): boolean {
  return (
    phase === "dependency_wait" ||
    phase === "scheduler_queue" ||
    phase === "retry_wait" ||
    phase === "recovery_wait" ||
    phase === "ci_wait" ||
    phase === "review_wait" ||
    phase === "merge_lock_wait"
  );
}

interface MutableTiming {
  available: boolean;
  hasEvents: boolean;
  activePhase: NodeTimingPhase | null;
  activeSinceMs: number;
  completedAtMs: number | null;
  lastTimestampMs: number;
  readonly totals: Map<NodeTimingPhase, number>;
}

function calculateNodeTimings(
  nodeIds: readonly string[],
  events: readonly PersistedRunEvent[],
): ReadonlyMap<string, NodeTiming> {
  // A single missing timestamp breaks at least one interval and the run start
  // boundary, so legacy logs fail closed instead of reporting partial totals.
  if (events.some((event) => event.timestampMs === null)) {
    return new Map();
  }
  const firstTimestampMs = events.find(
    (event) => event.timestampMs !== null,
  )?.timestampMs;
  if (firstTimestampMs === undefined || firstTimestampMs === null) {
    return new Map();
  }

  const mutable = new Map<string, MutableTiming>();
  for (const nodeId of nodeIds) {
    mutable.set(nodeId, {
      available: true,
      hasEvents: false,
      activePhase: "dependency_wait",
      activeSinceMs: firstTimestampMs,
      completedAtMs: null,
      lastTimestampMs: firstTimestampMs,
      totals: new Map(),
    });
  }

  for (const event of events) {
    const timing = mutable.get(event.nodeId);
    if (timing === undefined) continue;
    timing.hasEvents = true;
    if (event.timestampMs === null) {
      timing.available = false;
      continue;
    }
    const timestampMs = event.timestampMs;
    timing.lastTimestampMs = timestampMs;
    switch (event.kind) {
      case "node_ready":
        changePhase(timing, "scheduler_queue", timestampMs);
        break;
      case "node_started":
        changePhase(timing, "execution", timestampMs);
        break;
      case "node_phase_changed":
        changePhase(timing, event.phase, timestampMs);
        break;
      case "node_retry_wait":
        changePhase(timing, "retry_wait", timestampMs);
        break;
      case "node_reset":
        changePhase(timing, "recovery_wait", timestampMs);
        timing.completedAtMs = null;
        break;
      case "node_succeeded":
      case "node_failed":
      case "node_blocked":
      case "node_skipped":
      case "node_cancelled":
        completeTiming(timing, timestampMs);
        break;
      case "node_cancelling":
        break;
      default: {
        const unhandled: never = event;
        throw new Error(`unhandled timing event: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  // The run's latest observed timestamp, not the node's own: an in-progress
  // node may have been silent for hours, and its active phase owns all of
  // that time.
  const observedAtMs = events.reduce(
    (max, event) => Math.max(max, event.timestampMs ?? max),
    firstTimestampMs,
  );

  const result = new Map<string, NodeTiming>();
  for (const [nodeId, timing] of mutable) {
    if (!timing.available || !timing.hasEvents) continue;
    if (timing.completedAtMs === null) {
      closeActivePhase(timing, observedAtMs);
      timing.lastTimestampMs = observedAtMs;
    }
    const completedAtMs = timing.completedAtMs;
    const totalDurationMs = Math.max(
      0,
      (completedAtMs ?? timing.lastTimestampMs) - firstTimestampMs,
    );
    const phases = [...timing.totals.entries()].map(([phase, durationMs]) =>
      Object.freeze({ phase, durationMs }),
    );
    const attributedDurationMs = phases.reduce(
      (total, phase) => total + phase.durationMs,
      0,
    );
    result.set(
      nodeId,
      Object.freeze({
        startedAtMs: firstTimestampMs,
        completedAtMs,
        totalDurationMs,
        attributedDurationMs,
        unattributedDurationMs: Math.max(
          0,
          totalDurationMs - attributedDurationMs,
        ),
        phases: Object.freeze(phases),
      }),
    );
  }
  return result;
}

function changePhase(
  timing: MutableTiming,
  phase: NodeTimingPhase,
  timestampMs: number,
): void {
  closeActivePhase(timing, timestampMs);
  timing.activePhase = phase;
  timing.activeSinceMs = timestampMs;
}

function completeTiming(timing: MutableTiming, timestampMs: number): void {
  closeActivePhase(timing, timestampMs);
  timing.completedAtMs = timestampMs;
  timing.activePhase = null;
}

function closeActivePhase(timing: MutableTiming, timestampMs: number): void {
  if (timing.activePhase === null) return;
  const durationMs = Math.max(0, timestampMs - timing.activeSinceMs);
  timing.totals.set(
    timing.activePhase,
    (timing.totals.get(timing.activePhase) ?? 0) + durationMs,
  );
  timing.activeSinceMs = timestampMs;
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
