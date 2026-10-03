import type { CompiledGraph } from "../graph/types.js";
import type { PersistedRunEvent } from "./events.js";
import { readEventSnapshot, type NodeTimingPhase } from "./inspect.js";
import type { RunStore } from "./ports.js";

/**
 * Where a run's wall-clock time went, rebuilt from its persisted events.
 * `inspect` answers "what state is each node in"; this answers "what made
 * the run take as long as it did" — the realized critical path, how long
 * each phase lasts, how many review rounds implement nodes needed, and the
 * stretches when no worker was running at all (typically an operator wait).
 *
 * Read-only and deterministic: the same graph and event log always produce
 * the same numbers, so before/after comparisons across runs are meaningful.
 */

export interface PhaseShare {
  readonly phase: NodeTimingPhase;
  readonly durationMs: number;
  /** Fraction of the summed phase time it is listed with, from 0 through 1. */
  readonly share: number;
}

export interface PhaseStat {
  readonly phase: NodeTimingPhase;
  /** Contiguous intervals spent in this phase, across all nodes. */
  readonly count: number;
  readonly medianMs: number;
  readonly p90Ms: number;
  readonly totalMs: number;
}

export interface RealizedCriticalPath {
  /** Dependency chain ending at the last node to succeed, in run order. */
  readonly nodeIds: readonly string[];
  readonly implementNodeCount: number;
  /** Sum of the path nodes' phase time; parallel siblings are excluded. */
  readonly attributedMs: number;
  readonly phases: readonly PhaseShare[];
}

export interface ReviewRounds {
  /** Nodes that entered review_wait at least once, in graph order. */
  readonly nodes: readonly {
    readonly nodeId: string;
    readonly rounds: number;
  }[];
  /** Null when no node entered review_wait. */
  readonly mean: number | null;
  readonly max: number;
}

export interface IdleGap {
  readonly startedAtMs: number;
  readonly durationMs: number;
  /** The event that ended the gap, which is usually an operator action. */
  readonly endedBy: { readonly kind: string; readonly nodeId: string };
}

export interface IdleStats {
  /** Time between events while no worker node was running. */
  readonly totalMs: number;
  /** Largest gaps first. */
  readonly gaps: readonly IdleGap[];
}

export interface MergeStats {
  /** merge_resolve nodes merged by the orchestrator without an agent. */
  readonly direct: number;
  /** merge_resolve nodes that ran an agent session. */
  readonly agent: number;
  /** merge_resolve nodes satisfied by reconciliation (already merged). */
  readonly reconciled: number;
}

export interface RunStats {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly wallMs: number;
  /** Events without a timestamp (legacy logs) are left out of every figure. */
  readonly untimedEventCount: number;
  readonly criticalPath: RealizedCriticalPath;
  readonly phases: readonly PhaseStat[];
  readonly reviewRounds: ReviewRounds;
  readonly idle: IdleStats;
  readonly events: {
    readonly failed: number;
    readonly reset: number;
    readonly blocked: number;
    readonly cancelled: number;
    readonly retryWait: number;
  };
  readonly merges: MergeStats;
}

export interface RunStatsOptions {
  /**
   * Only silences at least this long count as idle, so the ordinary spacing
   * between events is not reported. Default 60000ms.
   */
  readonly idleThresholdMs?: number;
  /** How many of the largest idle gaps to keep. Default 5. */
  readonly maxIdleGaps?: number;
}

/**
 * Executors that finish instantly and do no agent work. Their running time
 * does not keep a run "busy" for idle accounting.
 */
const TRIVIAL_EXECUTORS: ReadonlySet<string> = new Set([
  "constant",
  "beads_update",
]);

/**
 * Compute stats for one run. Returns null when the log has no timestamped
 * events, which is the case for runs recorded before timestamps existed.
 */
export function computeRunStats(
  graph: CompiledGraph,
  events: readonly PersistedRunEvent[],
  options: RunStatsOptions = {},
): RunStats | null {
  const idleThresholdMs = options.idleThresholdMs ?? 60_000;
  const maxIdleGaps = options.maxIdleGaps ?? 5;
  const timed = events.filter(
    (event): event is PersistedRunEvent & { readonly timestampMs: number } =>
      event.timestampMs !== null,
  );
  const first = timed[0];
  if (first === undefined) return null;

  const executorOf = (nodeId: string): string | undefined =>
    graph.nodes[nodeId]?.executor;

  // Phase intervals per node. A repeated report of the active phase (the
  // adjudicator re-reports review_wait on every poll) extends the interval
  // rather than starting a new one.
  const active = new Map<
    string,
    { readonly phase: NodeTimingPhase; readonly sinceMs: number }
  >();
  const intervals = new Map<NodeTimingPhase, number[]>();
  const nodePhaseMs = new Map<string, Map<NodeTimingPhase, number>>();
  const seenPhases = new Map<string, Set<NodeTimingPhase>>();
  const reviewEntries = new Map<string, number>();
  // Log position of each node's latest success: timestamps can tie, the
  // append order cannot.
  const succeededSeq = new Map<string, number>();
  const running = new Set<string>();
  const counts = {
    failed: 0,
    reset: 0,
    blocked: 0,
    cancelled: 0,
    retryWait: 0,
  };
  const gaps: IdleGap[] = [];
  let idleMs = 0;
  let startedAtMs = first.timestampMs;
  let endedAtMs = first.timestampMs;
  let previousMs = first.timestampMs;

  const close = (nodeId: string, atMs: number): void => {
    const current = active.get(nodeId);
    if (current === undefined) return;
    active.delete(nodeId);
    const durationMs = Math.max(0, atMs - current.sinceMs);
    const list = intervals.get(current.phase) ?? [];
    list.push(durationMs);
    intervals.set(current.phase, list);
    const perNode =
      nodePhaseMs.get(nodeId) ?? new Map<NodeTimingPhase, number>();
    perNode.set(current.phase, (perNode.get(current.phase) ?? 0) + durationMs);
    nodePhaseMs.set(nodeId, perNode);
  };
  const enter = (
    nodeId: string,
    phase: NodeTimingPhase,
    atMs: number,
  ): void => {
    const current = active.get(nodeId);
    if (current?.phase === phase) return;
    close(nodeId, atMs);
    active.set(nodeId, { phase, sinceMs: atMs });
    const seen = seenPhases.get(nodeId) ?? new Set<NodeTimingPhase>();
    seen.add(phase);
    seenPhases.set(nodeId, seen);
    if (phase === "review_wait") {
      reviewEntries.set(nodeId, (reviewEntries.get(nodeId) ?? 0) + 1);
    }
  };

  for (const event of timed) {
    const atMs = event.timestampMs;
    if (atMs < startedAtMs) startedAtMs = atMs;
    if (atMs > endedAtMs) endedAtMs = atMs;

    const busy = [...running].some((nodeId) => {
      const executor = executorOf(nodeId);
      return executor === undefined || !TRIVIAL_EXECUTORS.has(executor);
    });
    const silenceMs = atMs - previousMs;
    if (!busy && silenceMs >= idleThresholdMs) {
      idleMs += silenceMs;
      gaps.push({
        startedAtMs: previousMs,
        durationMs: silenceMs,
        endedBy: { kind: event.kind, nodeId: event.nodeId },
      });
    }
    previousMs = Math.max(previousMs, atMs);

    const nodeId = event.nodeId;
    switch (event.kind) {
      case "node_ready":
        enter(nodeId, "scheduler_queue", atMs);
        break;
      case "node_started":
        running.add(nodeId);
        enter(nodeId, "execution", atMs);
        break;
      case "node_resource_wait":
        enter(nodeId, "resource_contention", atMs);
        break;
      case "node_phase_changed":
        enter(nodeId, event.phase, atMs);
        break;
      case "node_retry_wait":
        counts.retryWait += 1;
        running.delete(nodeId);
        enter(nodeId, "retry_wait", atMs);
        break;
      case "node_succeeded":
        succeededSeq.set(nodeId, event.seq);
        running.delete(nodeId);
        close(nodeId, atMs);
        break;
      case "node_failed":
        counts.failed += 1;
        running.delete(nodeId);
        close(nodeId, atMs);
        break;
      case "node_blocked":
        counts.blocked += 1;
        running.delete(nodeId);
        close(nodeId, atMs);
        break;
      case "node_cancelled":
        counts.cancelled += 1;
        running.delete(nodeId);
        close(nodeId, atMs);
        break;
      case "node_reset":
        counts.reset += 1;
        succeededSeq.delete(nodeId);
        running.delete(nodeId);
        close(nodeId, atMs);
        break;
      case "node_skipped":
        running.delete(nodeId);
        close(nodeId, atMs);
        break;
      case "node_cancelling":
      case "node_usage_reported":
      case "node_agent_progress":
        break;
      default: {
        const unhandled: never = event;
        throw new Error(`unhandled stats event: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  // A node still in a phase at the end of the log owns the time up to the
  // last observed event, as in inspect.
  for (const nodeId of [...active.keys()]) close(nodeId, endedAtMs);

  return Object.freeze({
    startedAtMs,
    endedAtMs,
    wallMs: endedAtMs - startedAtMs,
    untimedEventCount: events.length - timed.length,
    criticalPath: realizedCriticalPath(graph, succeededSeq, nodePhaseMs),
    phases: Object.freeze(phaseStats(intervals)),
    reviewRounds: reviewRounds(graph, reviewEntries),
    idle: Object.freeze({
      totalMs: idleMs,
      gaps: Object.freeze(
        gaps
          .sort(
            (left, right) =>
              right.durationMs - left.durationMs ||
              left.startedAtMs - right.startedAtMs,
          )
          .slice(0, maxIdleGaps),
      ),
    }),
    events: Object.freeze(counts),
    merges: mergeStats(graph, succeededSeq, seenPhases),
  });
}

/**
 * Stats for a persisted run, read as a bounded snapshot like inspect so an
 * in-progress run is measured up to now without waiting for more events.
 */
export async function readRunStats(
  store: RunStore,
  runId: string,
  options: RunStatsOptions = {},
): Promise<RunStats | null> {
  const stored = await store.getRun(runId);
  if (stored === undefined) {
    throw new Error(`unknown run: "${runId}"`);
  }
  const events = await readEventSnapshot(store, runId, stored.revision);
  return computeRunStats(stored.graph, events, options);
}

/**
 * Sum the critical-path phases of several runs, for comparing batches of
 * runs before and after a change.
 */
export function combineCriticalPathPhases(
  stats: readonly RunStats[],
): readonly PhaseShare[] {
  const totals = new Map<NodeTimingPhase, number>();
  for (const run of stats) {
    for (const phase of run.criticalPath.phases) {
      totals.set(
        phase.phase,
        (totals.get(phase.phase) ?? 0) + phase.durationMs,
      );
    }
  }
  return shares(totals);
}

/**
 * Walk back from the last node to succeed, each step taking the dependency
 * that succeeded last: the chain that actually gated the run's end. This is
 * the realized path, not the longest planned one, so operator waits and
 * retries on it show up as unattributed wall time.
 */
function realizedCriticalPath(
  graph: CompiledGraph,
  succeededSeq: ReadonlyMap<string, number>,
  nodePhaseMs: ReadonlyMap<string, ReadonlyMap<NodeTimingPhase, number>>,
): RealizedCriticalPath {
  const latest = (nodeIds: Iterable<string>): string | undefined => {
    let selected: string | undefined;
    for (const nodeId of nodeIds) {
      const seq = succeededSeq.get(nodeId);
      if (seq === undefined) continue;
      if (
        selected === undefined ||
        seq > (succeededSeq.get(selected) ?? -Infinity)
      ) {
        selected = nodeId;
      }
    }
    return selected;
  };
  const path: string[] = [];
  const visited = new Set<string>();
  let nodeId = latest(succeededSeq.keys());
  while (nodeId !== undefined && !visited.has(nodeId)) {
    visited.add(nodeId);
    path.push(nodeId);
    nodeId = latest(graph.nodes[nodeId]?.dependsOn ?? []);
  }
  path.reverse();

  const totals = new Map<NodeTimingPhase, number>();
  for (const pathNodeId of path) {
    for (const [phase, durationMs] of nodePhaseMs.get(pathNodeId) ?? []) {
      // Queueing for a slot is not work on the path; it is reported in the
      // per-phase table instead.
      if (phase === "scheduler_queue") continue;
      totals.set(phase, (totals.get(phase) ?? 0) + durationMs);
    }
  }
  return Object.freeze({
    nodeIds: Object.freeze(path),
    implementNodeCount: path.filter(
      (pathNodeId) => graph.nodes[pathNodeId]?.executor === "implement",
    ).length,
    attributedMs: [...totals.values()].reduce((sum, ms) => sum + ms, 0),
    phases: shares(totals),
  });
}

function phaseStats(
  intervals: ReadonlyMap<NodeTimingPhase, readonly number[]>,
): PhaseStat[] {
  return [...intervals.entries()]
    .map(([phase, durations]) => {
      const sorted = [...durations].sort((left, right) => left - right);
      return Object.freeze({
        phase,
        count: sorted.length,
        medianMs: percentile(sorted, 0.5),
        p90Ms: percentile(sorted, 0.9),
        totalMs: sorted.reduce((sum, ms) => sum + ms, 0),
      });
    })
    .sort(
      (left, right) =>
        right.totalMs - left.totalMs || left.phase.localeCompare(right.phase),
    );
}

function reviewRounds(
  graph: CompiledGraph,
  entries: ReadonlyMap<string, number>,
): ReviewRounds {
  const nodes = graph.order
    .filter((nodeId) => entries.has(nodeId))
    .map((nodeId) =>
      Object.freeze({ nodeId, rounds: entries.get(nodeId) as number }),
    );
  const total = nodes.reduce((sum, node) => sum + node.rounds, 0);
  return Object.freeze({
    nodes: Object.freeze(nodes),
    mean: nodes.length === 0 ? null : total / nodes.length,
    max: nodes.reduce((max, node) => Math.max(max, node.rounds), 0),
  });
}

/**
 * A merge_resolve agent session always reports integration_update; the
 * orchestrator's direct merge reports only merge. A node with neither was
 * satisfied by reconciliation before any session started.
 */
function mergeStats(
  graph: CompiledGraph,
  succeededSeq: ReadonlyMap<string, number>,
  seenPhases: ReadonlyMap<string, ReadonlySet<NodeTimingPhase>>,
): MergeStats {
  let direct = 0;
  let agent = 0;
  let reconciled = 0;
  for (const nodeId of succeededSeq.keys()) {
    if (graph.nodes[nodeId]?.executor !== "merge_resolve") continue;
    const seen = seenPhases.get(nodeId);
    if (seen?.has("integration_update") === true) agent += 1;
    else if (seen?.has("merge") === true) direct += 1;
    else reconciled += 1;
  }
  return Object.freeze({ direct, agent, reconciled });
}

function shares(totals: ReadonlyMap<NodeTimingPhase, number>): PhaseShare[] {
  const sum = [...totals.values()].reduce((total, ms) => total + ms, 0);
  return [...totals.entries()]
    .map(([phase, durationMs]) =>
      Object.freeze({
        phase,
        durationMs,
        share: sum === 0 ? 0 : durationMs / sum,
      }),
    )
    .sort(
      (left, right) =>
        right.durationMs - left.durationMs ||
        left.phase.localeCompare(right.phase),
    );
}

/** Nearest-rank percentile over an ascending list; 0 when empty. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] as number;
}
