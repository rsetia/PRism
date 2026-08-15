import type { CompiledGraph, JsonValue, NodeKind } from "../graph/types.js";
import type { GraphRevision } from "./graph-revision.js";
import type {
  GraphExpansionProposal,
  GraphProposalResult,
} from "./graph-revision.js";
import type { PersistedRunEvent, RunEvent, UsageReport } from "./events.js";
import type { NodePhase } from "./events.js";
import type { AgentProgressState } from "../node/agent-progress.js";
import type { FailureClass } from "./types.js";
import type { RunOutcome } from "./types.js";

/**
 * The seams (plan §4): the engine depends only on these interfaces.
 * Concrete adapters — memory today, durable/subprocess later — plug in
 * from outside. Expected failures are data; thrown errors from these
 * ports mean invalid API use or adapter bugs.
 */

/** What an executor returns. Failure is an outcome, not an exception. */
export type NodeExecutionOutcome =
  | { readonly status: "succeeded"; readonly output: JsonValue }
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
  readonly inputs: readonly JsonValue[];
  /** The node's opaque config, if any. Executors narrow it themselves. */
  readonly config?: JsonValue;
  /**
   * Aborted when the run is cancelled. Cooperative: executors SHOULD
   * observe it (it composes with fetch, timers, and subprocesses), but
   * the engine survives executors that ignore it — see
   * EngineOptions.cancelGracePeriodMs.
   */
  readonly signal: AbortSignal;
  /** Persist a transition to a named execution phase for timing attribution. */
  readonly reportPhase: (phase: NodePhase) => Promise<void>;
  /** Append normalized provider usage for this attempt. */
  readonly reportUsage?: (usage: UsageReport) => Promise<void>;
  /** Persist the latest agent-progress state for watch and inspect consumers. */
  readonly reportAgentProgress?: (state: AgentProgressState) => Promise<void>;
  /** Propose an append-only graph expansion through the engine's policy gate. */
  readonly submitGraphProposal?: (
    proposal: GraphExpansionProposal,
  ) => Promise<GraphProposalResult>;
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

interface StoredRunBase {
  readonly runId: string;
  readonly graph: CompiledGraph;
  /** Next event sequence; an optimistic revision for resume appends. */
  readonly revision: number;
  /** Revision of the graph snapshot currently dispatched by the scheduler. */
  readonly graphRevision: number;
}

/**
 * A persisted run. The v1 model makes the terminal invariant explicit:
 * unfinished runs have no outcome, and finished runs always have one.
 */
export type StoredRun =
  | (StoredRunBase & {
      readonly finished: false;
      readonly outcome?: never;
    })
  | (StoredRunBase & {
      readonly finished: true;
      readonly outcome: RunOutcome;
    });

/** A lightweight run listing, without the graph or events. */
export interface RunSummary {
  readonly runId: string;
  readonly finished: boolean;
}

/** A time-bounded exclusive claim on either a run coordinator or one node. */
export interface RunLease {
  readonly kind: "coordinator" | "node";
  readonly runId: string;
  readonly nodeId?: string;
  /** Opaque caller identity; stores never expose it to observers. */
  readonly owner: string;
  /** Monotonically increasing generation used to fence replaced owners. */
  readonly fencingToken: number;
  readonly expiresAtMs: number;
}

/** Safe ownership information suitable for status and inspect output. */
export interface RunLeaseStatus {
  readonly kind: RunLease["kind"];
  readonly nodeId?: string;
  readonly fencingToken: number;
  readonly expiresAtMs: number;
}

/**
 * Persistence port. Contract (plan §4, decided):
 * - createRun rejects a duplicate runId.
 * - appendEvents assigns `seq` — monotonic per run, gapless, from 0 — and a
 *   stable Unix-epoch `timestampMs` atomically for the whole batch, and
 *   returns the persisted events. Stores may return timestampMs null only
 *   when reading legacy events that predate timestamp persistence.
 *   When expectedRevision is supplied, it rejects unless that is the
 *   run's next sequence. Rejects for an unknown or finished run.
 * - readEvents is a cursor over the persisted log starting at `fromSeq`
 *   (default 0): each call is an independent iterator that yields
 *   existing events, waits for new ones, and completes once the run is
 *   finished and the log is drained. Unknown runId rejects on iteration.
 * - Appending never waits on consumers — the engine only notifies.
 * - finishRun atomically persists the terminal outcome and marks the run
 *   finished. It is idempotent; the first persisted outcome wins.
 * - reopenRun clears the finished flag so a reset run can be resumed;
 *   idempotent, and rejects an unknown run. It is administrative recovery
 *   (plan §16) — the caller is responsible for the run's consistency.
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
    lease?: RunLease,
  ): Promise<readonly PersistedRunEvent[]>;
  readEvents(runId: string, fromSeq?: number): AsyncIterable<PersistedRunEvent>;
  getRun(runId: string): Promise<StoredRun | undefined>;
  listRuns(): Promise<readonly RunSummary[]>;
  finishRun(
    runId: string,
    outcome: RunOutcome,
    lease?: RunLease,
  ): Promise<void>;
  reopenRun(runId: string, lease?: RunLease): Promise<void>;
  /** Acquire an exclusive renewable coordinator lease, or reject on conflict. */
  acquireCoordinatorLease(
    runId: string,
    owner: string,
    durationMs: number,
  ): Promise<RunLease>;
  /** Acquire an exclusive renewable per-node lease, or reject on conflict. */
  acquireNodeLease(
    runId: string,
    nodeId: string,
    owner: string,
    durationMs: number,
  ): Promise<RunLease>;
  /** Extend a lease only when its fencing token remains current. */
  renewLease(lease: RunLease, durationMs: number): Promise<RunLease>;
  /** Idempotently release a current lease. Stale releases cannot release a successor. */
  releaseLease(lease: RunLease): Promise<void>;
  /** Returns current non-expired ownership without exposing owner identities. */
  getRunLeases(runId: string): Promise<readonly RunLeaseStatus[]>;
  /**
   * Atomically records an audited graph decision. Accepted revisions replace
   * the run's graph snapshot; rejected revisions deliberately leave it alone.
   * Re-submitting the same proposal id is idempotent.
   */
  appendGraphRevision?(
    runId: string,
    revision: GraphRevision,
    expectedGraphRevision: number,
  ): Promise<GraphRevision>;
  /** Durable audit trail, including rejected proposals, in decision order. */
  listGraphRevisions?(runId: string): Promise<readonly GraphRevision[]>;
  close?(): Promise<void>;
}

/** Opaque metadata for bytes persisted by an ArtifactStore. */
export interface ArtifactRef {
  /** Opaque locator resolvable by the store that produced it. */
  readonly uri: string;
  readonly filename: string;
  readonly contentType?: string;
  /** Size in bytes. */
  readonly size: number;
}

export interface PutArtifactInput {
  readonly runId: string;
  readonly nodeId: string;
  /** 1-based attempt the artifact belongs to. */
  readonly attempt: number;
  readonly filename: string;
  readonly data: Uint8Array;
  readonly contentType?: string;
}

export interface ArtifactLocator {
  readonly runId: string;
  readonly nodeId: string;
}

/**
 * Binary artifact persistence port.
 *
 * Contract:
 * - runId, nodeId, attempt, and filename form the logical identity. String
 *   identifiers are opaque and distinct values must never alias.
 * - attempt is a positive integer.
 * - put snapshots the supplied bytes and returns their filename, byte size,
 *   optional content type, and a non-empty opaque URI.
 * - get resolves URIs produced by this store to a fresh byte snapshot and
 *   rejects unknown URIs.
 * - list returns a point-in-time collection of every artifact for a node
 *   across attempts. Its order is unspecified; an unknown node returns [].
 * - close optionally releases underlying clients or connections. The store
 *   must not be used afterward.
 */
export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<ArtifactRef>;
  get(uri: string): Promise<Uint8Array>;
  list(locator: ArtifactLocator): Promise<readonly ArtifactRef[]>;
  close?(): Promise<void>;
}

export interface LogTarget {
  readonly runId: string;
  readonly nodeId: string;
  /** 1-based attempt whose log this is. */
  readonly attempt: number;
}

export interface LogWriter {
  /**
   * Appends one text chunk. Concurrent calls are serialized in invocation
   * order.
   */
  write(chunk: string): Promise<void>;
  /** Marks the log complete. Idempotent. */
  close(): Promise<void>;
}

export interface ReadLogOptions {
  /**
   * Keep yielding as more is written, ending only when the active writer
   * closes. Default false: yield the current snapshot, then end.
   */
  readonly follow?: boolean;
  /** Abort a follow early. Aborting ends iteration without an error. */
  readonly signal?: AbortSignal;
}

/**
 * Text log persistence and streaming port.
 *
 * Contract:
 * - runId, nodeId, and attempt form the logical identity. String identifiers
 *   are opaque and distinct values must never alias.
 * - attempt is a positive integer.
 * - only one writer may be open for a target at a time. Writes are append-only
 *   and ordered within that writer; close is idempotent, and later writes
 *   reject. Reopening a closed target starts a new log generation and replaces
 *   the prior text, matching an administrative reset that reuses attempt 1.
 * - a default read returns the current text snapshot and does not wait for an
 *   open writer.
 * - a follow read returns existing text, continues with appended text, and
 *   ends when the writer closes or its signal aborts. Chunk boundaries are
 *   unspecified; concatenated text is exact.
 * - multiple readers own independent cursors.
 * - close optionally releases underlying clients or connections. The backend
 *   must not be used afterward.
 */
export interface LogBackend {
  openWriter(target: LogTarget): Promise<LogWriter>;
  read(target: LogTarget, options?: ReadLogOptions): AsyncIterable<string>;
  close?(): Promise<void>;
}
