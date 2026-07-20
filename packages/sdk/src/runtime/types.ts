import type { JsonValue } from "../graph/types.js";

/**
 * Node lifecycle states (plan §3). String union, no payload: outputs and
 * failures live in the run snapshot, not inside the state — and the alpha
 * has no retries, so there's no attempt counter yet. Shaped so
 * `retry_wait`, `cancelling`, and `cancelled` can be added without
 * breaking.
 *
 * Legal moves:
 *   pending -> ready -> running -> succeeded | failed
 *   pending -> blocked   (a dependency failed or was blocked; terminal)
 */
export type NodeState =
  "pending" | "ready" | "running" | "succeeded" | "failed" | "blocked";

/** Terminal states are absorbing: every further event is an invariant error. */
export const TERMINAL_NODE_STATES: ReadonlySet<NodeState> = new Set([
  "succeeded",
  "failed",
  "blocked",
]);

/**
 * An originating node failure. `cause` is already-normalized JSON — the
 * executor adapter (section 4) owns turning thrown values into this shape;
 * by the time a failure is data, it is persistable.
 */
export interface NodeFailure {
  readonly nodeId: string;
  readonly cause: JsonValue;
}

/**
 * How every run resolves — never rejects for expected failures.
 * `failures` lists only originating failures (root causes); blocked
 * nodes are visible in the final node states, not duplicated here.
 */
export type RunOutcome =
  | { readonly status: "succeeded"; readonly output: unknown }
  | { readonly status: "failed"; readonly failures: readonly NodeFailure[] };
