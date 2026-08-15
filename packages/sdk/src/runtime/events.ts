import type { JsonValue } from "../graph/types.js";
import type { NodeFailure } from "./types.js";

/** Stable phase names used for per-node wall-time attribution. */
export const NODE_PHASES = Object.freeze([
  "execution",
  "worktree_setup",
  "implementation",
  "validation",
  "pull_request",
  "ci_wait",
  "review_wait",
  "merge_lock_wait",
  "integration_update",
  "conflict_resolution",
  "merge_validation",
  "merge",
  "tracker_update",
  "finalization",
  "workspace_cleanup",
] as const);

export type NodePhase = (typeof NODE_PHASES)[number];

/**
 * The subset of NODE_PHASES a worker may report. The rest (execution,
 * worktree_setup, tracker_update, workspace_cleanup) are orchestrator
 * bookkeeping — accepting them from phase.json would let a confused worker
 * reclassify its implementation time as orchestrator overhead.
 */
export const WORKER_PHASES = Object.freeze([
  "implementation",
  "validation",
  "pull_request",
  "ci_wait",
  "review_wait",
  "merge_lock_wait",
  "integration_update",
  "conflict_resolution",
  "merge_validation",
  "merge",
  "finalization",
] as const satisfies readonly NodePhase[]);

export type WorkerPhase = (typeof WORKER_PHASES)[number];

/**
 * Events are facts: the engine's only way of changing state, and later the
 * persistence format. Discriminated on `kind` so an exhaustive switch with
 * a `never` default catches unhandled kinds at compile time.
 *
 * Node events only, for now — run-level events can be added as new kinds
 * without breaking existing consumers (additive is compatible; renaming or
 * reusing a kind never is).
 */
export type RunEvent =
  | { readonly kind: "node_ready"; readonly nodeId: string }
  | {
      readonly kind: "node_resource_wait";
      readonly nodeId: string;
      /** Currently saturated requests, in deterministic resource order. */
      readonly resourceIds: readonly string[];
    }
  | { readonly kind: "node_started"; readonly nodeId: string }
  | {
      readonly kind: "node_phase_changed";
      readonly nodeId: string;
      readonly phase: NodePhase;
    }
  | {
      readonly kind: "node_succeeded";
      readonly nodeId: string;
      readonly output: JsonValue;
    }
  | {
      readonly kind: "node_failed";
      readonly nodeId: string;
      readonly failure: NodeFailure;
    }
  | {
      readonly kind: "node_blocked";
      readonly nodeId: string;
      /** The failed-or-blocked dependencies that caused this. */
      readonly blockedBy: readonly string[];
    }
  | { readonly kind: "node_skipped"; readonly nodeId: string }
  | { readonly kind: "node_cancelling"; readonly nodeId: string }
  | { readonly kind: "node_cancelled"; readonly nodeId: string }
  | {
      readonly kind: "node_retry_wait";
      readonly nodeId: string;
      /** The attempt that just failed, 1-based. */
      readonly attempt: number;
      /** Backoff before the next attempt, in milliseconds. */
      readonly delayMs: number;
      /**
       * The failure being retried. Recorded for observability only — a
       * retried failure is NOT an originating failure, so it never
       * reaches the run outcome unless retries are exhausted.
       */
      readonly failure: NodeFailure;
    }
  | {
      /**
       * Administrative recovery (plan §16, signal / rerun-node): move a
       * node back to `pending` from ANY state, including a terminal one.
       * This is the sanctioned exception to absorbing terminal states —
       * an operator resets a node so a later resume re-runs it. The caller
       * is responsible for ensuring no live worker still owns the node.
       */
      readonly kind: "node_reset";
      readonly nodeId: string;
    };

/**
 * An event as the store returns it. `seq` and `timestampMs` are assigned by
 * the store on append — never by the event's producer. `seq` is monotonic per
 * run, gapless, and starts at 0. `timestampMs` is Unix epoch milliseconds and
 * remains stable across reads. It is null only for events loaded from a
 * pre-timestamp store.
 */
export type PersistedRunEvent = RunEvent & {
  readonly seq: number;
  readonly timestampMs: number | null;
};
