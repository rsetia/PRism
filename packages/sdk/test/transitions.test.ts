import { describe, expect, test } from "vitest";
import { IllegalTransitionError, reduceNodeState } from "../src/index.js";
import type { NodeState, RunEvent } from "../src/index.js";

/**
 * The exhaustive table: every state × every event kind, generated so no
 * combination can be forgotten. 9 legal transitions; the other 47 must
 * throw — including everything aimed at a terminal state (absorbing).
 * This is the 100%-branch-coverage file (plan §3; cancellation rows §10).
 */

const STATES: readonly NodeState[] = [
  "pending",
  "ready",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelling",
  "cancelled",
];

const EVENTS: readonly RunEvent[] = [
  { kind: "node_ready", nodeId: "n" },
  { kind: "node_started", nodeId: "n" },
  { kind: "node_succeeded", nodeId: "n", output: "value" },
  { kind: "node_failed", nodeId: "n", failure: { nodeId: "n", cause: "boom" } },
  { kind: "node_blocked", nodeId: "n", blockedBy: ["dep"] },
  { kind: "node_cancelling", nodeId: "n" },
  { kind: "node_cancelled", nodeId: "n" },
];

const LEGAL = new Map<string, NodeState>([
  ["pending+node_ready", "ready"],
  ["pending+node_blocked", "blocked"],
  ["ready+node_started", "running"],
  ["running+node_succeeded", "succeeded"],
  ["running+node_failed", "failed"],
  ["pending+node_cancelled", "cancelled"],
  ["ready+node_cancelled", "cancelled"],
  ["running+node_cancelling", "cancelling"],
  ["cancelling+node_cancelled", "cancelled"],
]);

describe("reduceNodeState", () => {
  for (const state of STATES) {
    for (const event of EVENTS) {
      const key = `${state}+${event.kind}`;
      const expected = LEGAL.get(key);
      if (expected !== undefined) {
        test(`${key} -> ${expected}`, () => {
          expect(reduceNodeState(state, event)).toBe(expected);
        });
      } else {
        test(`${key} throws IllegalTransitionError`, () => {
          expect(() => reduceNodeState(state, event)).toThrow(
            IllegalTransitionError,
          );
        });
      }
    }
  }

  test("IllegalTransitionError carries structured fields", () => {
    try {
      reduceNodeState("succeeded", { kind: "node_started", nodeId: "n" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      if (error instanceof IllegalTransitionError) {
        expect(error.state).toBe("succeeded");
        expect(error.eventKind).toBe("node_started");
      }
    }
  });
});
