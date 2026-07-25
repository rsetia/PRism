import type { CompiledGraph, JsonValue, NodeKind } from "../graph/types.js";
import type { PersistedRunEvent, RunEvent } from "./events.js";
import type { FailureClass } from "./types.js";

/**
 * The seams (plan §4): the engine depends only on these interfaces.
 * Concrete adapters — memory today, durable/subprocess later — plug in
 * from outside. Expected failures are data; thrown errors from these
 * ports mean invalid API use or adapter bugs.
 */

/** What an executor returns. Failure is an outcome, not an exception. */
export type NodeExecutionOutcome =
  | { readonly status: "succeeded"; readonly output: unknown }
  | {
      readonly status: "failed";
      readonly cause: JsonValue;
      /**
       * Why it failed. Only the executor has the context to say, so only
       * the executor sets it; omitting it means "unclassified" and the
       * retry policy applies its default.
       */
      readonly failureClass?: FailureClass;
    };

/** Everything a node execution gets to see. */
export interface ExecutionContext {
  /** The run this execution belongs to. */
  readonly runId: string;
  readonly nodeId: string;
  /** The node's category, so an executor can adapt to task vs merge. */
  readonly kind: NodeKind;
  /** 1-based attempt number, incremented on each retry of this node. */
  readonly attempt: number;
  /** Upstream outputs, in the node's dependsOn order. */
  readonly inputs: readonly unknown[];
  /** The node's opaque config, if any. Executors narrow it themselves. */
  readonly config?: JsonValue;
  /**
   * Aborted when the run is cancelled. Cooperative: executors SHOULD
   * observe it (it composes with fetch, timers, and subprocesses), but
   * the engine survives executors that ignore it — see
   * EngineOptions.cancelGracePeriodMs.
   */
  readonly signal: AbortSignal;
}

/**
 * A named executor. `execute` may return or throw — the engine catches
 * and normalizes thrown values via normalizeThrownCause; executors
 * should still prefer returning failure as data.
 */
export interface ExecutorDefinition {
  readonly name: string;
  readonly execute: (
    context: ExecutionContext,
  ) => NodeExecutionOutcome | Promise<NodeExecutionOutcome>;
  /**
   * Optional config check run at preflight, before any node starts
   * (plan §13, PRism-py's validate_config). Throw an Error describing the
   * problem to reject the whole run as misconfigured — a config mistake
   * is a bad graph, not a node failure, so it never starts a run. Absent
   * means "any config accepted". Pure: no I/O, no side effects.
   */
  readonly validateConfig?: (config: JsonValue | undefined) => void;
}

/**
 * Immutable lookup of executors, passed to the engine explicitly —
 * never a global mutable registry.
 */
export interface ExecutorRegistry {
  get(name: string): ExecutorDefinition | undefined;
  has(name: string): boolean;
  /** All registered names, in registration order. */
  readonly names: readonly string[];
}

/**
 * Time as a port (plan §11): the engine never calls Date.now or
 * setTimeout directly, so tests advance a manual clock instead of
 * sleeping through real backoff.
 */
export interface Clock {
  /** Current time as epoch milliseconds. */
  now(): number;
  /**
   * Resolves after `ms` have elapsed. If `signal` is provided and aborts
   * first, the promise REJECTS with an AbortError-named error — that is
   * how cancellation interrupts a retry backoff.
   */
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface CreateRunInput {
  readonly runId: string;
  /** Snapshot stored at creation — the down payment for durable resume. */
  readonly graph: CompiledGraph;
}

export interface StoredRun {
  readonly runId: string;
  readonly graph: CompiledGraph;
  readonly finished: boolean;
  /** Next event sequence; an optimistic revision for resume appends. */
  readonly revision: number;
}

/** A lightweight run listing, without the graph or events. */
export interface RunSummary {
  readonly runId: string;
  readonly finished: boolean;
}

/**
 * Persistence port. Contract (plan §4, decided):
 * - createRun rejects a duplicate runId.
 * - appendEvents assigns `seq` — monotonic per run, gapless, from 0 —
 *   atomically for the whole batch, and returns the persisted events.
 *   When expectedRevision is supplied, it rejects unless that is the
 *   run's next sequence. Rejects for an unknown or finished run.
 * - readEvents is a cursor over the persisted log starting at `fromSeq`
 *   (default 0): each call is an independent iterator that yields
 *   existing events, waits for new ones, and completes once the run is
 *   finished and the log is drained. Unknown runId rejects on iteration.
 * - Appending never waits on consumers — the engine only notifies.
 * - finishRun is idempotent.
 * - listRuns returns every run's summary, most-recent-created first.
 * - close releases any underlying resource (a database handle). Optional:
 *   a purely in-memory store needs nothing to release. After close, the
 *   store must not be used again.
 */
export interface RunStore {
  createRun(input: CreateRunInput): Promise<void>;
  appendEvents(
    runId: string,
    events: readonly RunEvent[],
    expectedRevision?: number,
  ): Promise<readonly PersistedRunEvent[]>;
  readEvents(runId: string, fromSeq?: number): AsyncIterable<PersistedRunEvent>;
  getRun(runId: string): Promise<StoredRun | undefined>;
  listRuns(): Promise<readonly RunSummary[]>;
  finishRun(runId: string): Promise<void>;
  close?(): Promise<void>;
}
