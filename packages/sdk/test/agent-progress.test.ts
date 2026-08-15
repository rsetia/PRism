import { describe, expect, test } from "vitest";
import { assessAgentProgress } from "../src/node/index.js";
import type { AgentProgressSnapshot } from "../src/node/index.js";

function snapshot(
  overrides: Partial<AgentProgressSnapshot> = {},
): AgentProgressSnapshot {
  return {
    capability: "structured",
    processLivenessAtMs: 1_000,
    lastModelEventAtMs: null,
    lastToolEventAtMs: null,
    lastWorkspaceMutationAtMs: null,
    lastPhaseTransitionAtMs: null,
    externalWait: null,
    decisions: [],
    ...overrides,
  };
}

const policy = { timeoutMs: 100, action: "escalate" as const, maxAttempts: 2 };

describe("assessAgentProgress", () => {
  test("does not mistake a live supervisor for agent progress", () => {
    const assessment = assessAgentProgress(snapshot(), 1_000, policy);
    expect(assessment.state).toBe("stalled");
    expect(assessment.decision).toMatchObject({
      action: "escalate",
      attempt: 1,
    });
  });

  test("model, tool, workspace, and phase signals reset the progress clock", () => {
    for (const signal of [
      "lastModelEventAtMs",
      "lastToolEventAtMs",
      "lastWorkspaceMutationAtMs",
      "lastPhaseTransitionAtMs",
    ] as const) {
      expect(
        assessAgentProgress(snapshot({ [signal]: 950 }), 1_000, policy).state,
      ).toBe("active");
    }
  });

  test("a healthy CI or review poll is waiting, not stalled", () => {
    const assessment = assessAgentProgress(
      snapshot({
        externalWait: {
          kind: "review",
          enteredAtMs: 0,
          lastHealthyPollAtMs: 990,
          pollIntervalMs: 20,
        },
      }),
      1_000,
      policy,
    );
    expect(assessment.state).toBe("waiting");
  });

  test("does not duplicate a durable action after resume", () => {
    const assessment = assessAgentProgress(
      snapshot({
        decisions: [
          { action: "escalate", atMs: 1, attempt: 1, reason: "no_progress" },
        ],
      }),
      1_000,
      policy,
    );
    expect(assessment.decision).toMatchObject({ attempt: 2 });
    const exhausted = assessAgentProgress(
      snapshot({
        decisions: [
          { action: "escalate", atMs: 1, attempt: 1, reason: "no_progress" },
          { action: "escalate", atMs: 2, attempt: 2, reason: "no_progress" },
        ],
      }),
      1_000,
      policy,
    );
    expect(exhausted.decision).toBeNull();
  });

  test("calls compatibility backends unobservable", () => {
    expect(
      assessAgentProgress(snapshot({ capability: "reduced" }), 1_000, policy)
        .state,
    ).toBe("unobservable");
  });
});
