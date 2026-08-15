import type { RunEvent } from "./events.js";
import type { NodeState } from "./types.js";

/**
 * An engine bug, not an expected failure — which is why this throws
 * instead of resolving as data. Identity is the structured fields; the
 * message is derived presentation.
 */
export class IllegalTransitionError extends Error {
  readonly state: NodeState;
  readonly eventKind: RunEvent["kind"];

  constructor(state: NodeState, eventKind: RunEvent["kind"]) {
    super(`illegal transition: event "${eventKind}" in state "${state}"`);
    this.name = "IllegalTransitionError";
    this.state = state;
    this.eventKind = eventKind;
  }
}

/**
 * The one pure function that moves node state. No clock, no I/O, no
 * randomness — same inputs, same output, always; that's what makes event
 * replay deterministic.
 *
 * The caller routes: `event` is always an event *for the node* whose
 * state is `previous` — this function never checks `event.nodeId`.
 *
 * Legal transitions (everything else throws IllegalTransitionError):
 *   pending  + node_ready     -> ready
 *   pending  + node_blocked   -> blocked
 *   ready    + node_started   -> running
 *   running | cancelling + node_phase_changed -> unchanged
 *   running  + node_succeeded -> succeeded
 *   running  + node_failed    -> failed
 *   running  + node_retry_wait -> retry_wait
 *   running  + node_cancelling -> cancelling
 *   cancelling + node_cancelled -> cancelled
 *   cancelling + node_failed | node_retry_wait -> failed | retry_wait
 *     (resume recovery after an interrupted executor)
 *   retry_wait + node_ready | node_cancelled -> ready | cancelled
 *   pending | ready + node_cancelled -> cancelled
 *
 * Implementation notes: switch on event.kind with a `never` default arm,
 * so adding an event kind refuses to compile until it's handled here.
 */
export function reduceNodeState(
  previous: NodeState,
  event: RunEvent,
): NodeState {
  switch (event.kind) {
    case "node_ready":
      if (previous === "pending" || previous === "retry_wait") {
        return "ready";
      }
      break;

    case "node_started":
      if (previous === "ready") {
        return "running";
      }
      break;

    case "node_phase_changed":
      if (previous === "running" || previous === "cancelling") {
        return previous;
      }
      break;

    case "node_succeeded":
      if (previous === "running") {
        return "succeeded";
      }
      break;

    case "node_failed":
      if (previous === "running" || previous === "cancelling") {
        return "failed";
      }
      break;

    case "node_blocked":
      if (previous === "pending") {
        return "blocked";
      }
      break;

    case "node_cancelling":
      if (previous === "running") {
        return "cancelling";
      }
      break;

    case "node_retry_wait":
      if (previous === "running" || previous === "cancelling") {
        return "retry_wait";
      }
      break;

    case "node_cancelled":
      if (
        previous === "pending" ||
        previous === "ready" ||
        previous === "cancelling" ||
        previous === "retry_wait"
      ) {
        return "cancelled";
      }
      break;

    case "node_reset":
      // Administrative recovery: legal from EVERY state, including
      // terminal ones. This is the one sanctioned break from absorbing
      // terminal states (plan §16) — an operator resets a node to pending
      // so a later resume re-runs it.
      return "pending";

    default: {
      const unhandledEvent: never = event;
      throw new Error(`unhandled run event: ${JSON.stringify(unhandledEvent)}`);
    }
  }

  throw new IllegalTransitionError(previous, event.kind);
}
