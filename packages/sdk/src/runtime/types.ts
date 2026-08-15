import type { JsonValue } from "../graph/types.js";

/**
 * Node lifecycle states (plan §3). String union, no payload: outputs and
 * failures live in the run snapshot, not inside the state — and the alpha
 * keeps attempt counters in the scheduler rather than encoding them in
 * the state string.
 *
 * Legal moves:
 *   pending -> ready -> running -> succeeded | failed
 *   pending -> blocked      (a dependency failed or was blocked; terminal)
 *   pending -> skipped      (its declarative condition evaluated false; terminal)
 *   pending | ready -> cancelled            (cancellation accepted directly)
 *   running -> cancelling -> cancelled      (waits for the executor to settle)
 *   running -> retry_wait -> ready          (retryable failure; backoff then re-run)
 *   retry_wait -> cancelled                 (cancellation while waiting to retry)
 */
export type NodeState =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "cancelling"
  | "cancelled"
  | "retry_wait";

/** Terminal states are absorbing: every further event is an invariant error. */
export const TERMINAL_NODE_STATES: ReadonlySet<NodeState> = new Set([
  "succeeded",
  "failed",
  "blocked",
  "skipped",
  "cancelled",
]);

/**
 * Why a node failed — the taxonomy retry decisions key off (plan §11;
 * adopted verbatim from PRism-py's FailureClass so parity is exact).
 *
 * Rough guide: `transient_infra` and `timeout` are the retryable ones by
 * default; `validation_failed` and `semantic_failed` mean the work was
 * wrong, not unlucky; `merge_conflict`, `policy_denied`, and
 * `manual_review_required` need a human or a different strategy.
 */
export type FailureClass =
  | "transient_infra"
  | "timeout"
  | "validation_failed"
  | "semantic_failed"
  | "merge_conflict"
  | "policy_denied"
  | "manual_review_required";

/**
 * An originating node failure. `cause` is already-normalized JSON — the
 * executor adapter (section 4) owns turning thrown values into this shape;
 * by the time a failure is data, it is persistable.
 *
 * `failureClass` is optional: only the executor knows why it failed, so
 * only the executor sets it. Absent means "unclassified" — retry
 * decisions treat that as `transient_infra` (see resolveFailureClass),
 * but nothing rewrites the recorded failure.
 */
export interface NodeFailure {
  readonly nodeId: string;
  readonly cause: JsonValue;
  readonly failureClass?: FailureClass;
}

/**
 * How every run resolves — never rejects for expected failures.
 * `failures` lists only originating failures (root causes); blocked
 * nodes are visible in the final node states, not duplicated here.
 */
export type RunOutcome =
  | { readonly status: "succeeded"; readonly output: JsonValue }
  | { readonly status: "failed"; readonly failures: readonly NodeFailure[] }
  | {
      readonly status: "cancelled";
      /** The value passed to cancel(); null when none was given. */
      readonly reason: JsonValue;
      /** Originating failures observed before cancellation; may be empty. */
      readonly failures: readonly NodeFailure[];
    };
