import { describe, expect, test } from "vitest";
import { IllegalTransitionError, reduceNodeState } from "../src/index.js";
import type { NodeState, RunEvent } from "../src/index.js";

/**
 * The exhaustive table: every state × every event kind, generated so no
 * combination can be forgotten. node_reset is legal from EVERY state (the
 * sanctioned administrative escape from absorbing terminals, §16); every
 * other event that reaches a terminal state must throw.
 * This is the 100%-branch-coverage file (plan §3; cancellation rows §10,
 * retry rows §11, interrupted recovery rows §12, reset rows §16).
 */

const STATES: readonly NodeState[] = [
  "pending",
  "ready",
  "resource_wait",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "skipped",
  "cancelling",
  "cancelled",
  "retry_wait",
];

const EVENTS: readonly RunEvent[] = [
  { kind: "node_ready", nodeId: "n" },
  { kind: "node_started", nodeId: "n" },
  { kind: "node_resource_wait", nodeId: "n", resourceIds: ["shared"] },
  { kind: "node_succeeded", nodeId: "n", output: "value" },
  { kind: "node_failed", nodeId: "n", failure: { nodeId: "n", cause: "boom" } },
  { kind: "node_blocked", nodeId: "n", blockedBy: ["dep"] },
  { kind: "node_skipped", nodeId: "n" },
  { kind: "node_cancelling", nodeId: "n" },
  { kind: "node_cancelled", nodeId: "n" },
  {
    kind: "node_retry_wait",
    nodeId: "n",
    attempt: 1,
    delayMs: 100,
    failure: { nodeId: "n", cause: "boom", failureClass: "transient_infra" },
  },
  { kind: "node_reset", nodeId: "n" },
];

const LEGAL = new Map<string, NodeState>([
  // node_reset -> pending from every state (administrative recovery).
  ...STATES.map(
    (state) => [`${state}+node_reset`, "pending"] as [string, NodeState],
  ),
  ["pending+node_ready", "ready"],
  ["pending+node_blocked", "blocked"],
  ["pending+node_skipped", "skipped"],
  ["ready+node_started", "running"],
  ["ready+node_resource_wait", "resource_wait"],
  ["resource_wait+node_resource_wait", "resource_wait"],
  ["resource_wait+node_started", "running"],
  ["running+node_succeeded", "succeeded"],
  ["running+node_failed", "failed"],
  ["cancelling+node_failed", "failed"],
  ["pending+node_cancelled", "cancelled"],
  ["ready+node_cancelled", "cancelled"],
  ["resource_wait+node_cancelled", "cancelled"],
  ["running+node_cancelling", "cancelling"],
  ["cancelling+node_cancelled", "cancelled"],
  ["running+node_retry_wait", "retry_wait"],
  ["cancelling+node_retry_wait", "retry_wait"],
  ["retry_wait+node_ready", "ready"],
  ["retry_wait+node_cancelled", "cancelled"],
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
