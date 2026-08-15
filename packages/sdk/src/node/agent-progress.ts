/**
 * Structured evidence used to supervise an agent session.  A process
 * heartbeat deliberately does not appear in `lastProgressAt`: it proves
 * that the supervisor is alive, not that the agent is making progress.
 */
export interface AgentProgressSnapshot {
  readonly capability: "structured" | "reduced" | "unobservable";
  /**
   * Durable start time for this session. This gives a new or resumed session
   * one policy timeout to emit its first structured progress event without
   * treating repeated process heartbeats as progress.
   */
  readonly sessionStartedAtMs: number;
  /** The agent process was last known to be alive at this time. */
  readonly processLivenessAtMs: number | null;
  readonly lastModelEventAtMs: number | null;
  readonly lastToolEventAtMs: number | null;
  readonly lastWorkspaceMutationAtMs: number | null;
  readonly lastPhaseTransitionAtMs: number | null;
  /** A CI/review poll that is still healthy is an explicit non-stall. */
  readonly externalWait: ExternalWaitState | null;
  /** Decisions already made by the session, restored on resume. */
  readonly decisions: readonly AgentStallDecision[];
}

export interface ExternalWaitState {
  readonly kind: "ci" | "review" | "external";
  readonly enteredAtMs: number;
  readonly lastHealthyPollAtMs: number;
  /** Maximum permitted age of a healthy poll. */
  readonly pollIntervalMs: number;
}

export type StallAction = "warn" | "request_status" | "restart" | "escalate";

export interface StallPolicy {
  readonly timeoutMs: number;
  readonly action: StallAction;
  /** Maximum durable attempts for this action. Defaults to one. */
  readonly maxAttempts?: number;
}

export interface AgentStallDecision {
  readonly action: StallAction;
  readonly atMs: number;
  readonly attempt: number;
  readonly reason: "no_progress";
}

export type AgentProgressState =
  "active" | "waiting" | "stalled" | "unobservable";

export interface AgentProgressAssessment {
  readonly state: AgentProgressState;
  readonly lastProgressAtMs: number | null;
  readonly decision: AgentStallDecision | null;
}

/**
 * Evaluate a snapshot without side effects.  Backends persist and perform
 * the returned decision, which makes resuming a session naturally idempotent.
 */
export function assessAgentProgress(
  snapshot: AgentProgressSnapshot,
  now: number,
  policy: StallPolicy,
): AgentProgressAssessment {
  validatePolicy(policy);
  if (snapshot.capability !== "structured") {
    return Object.freeze({
      state: "unobservable",
      lastProgressAtMs: null,
      decision: null,
    });
  }

  const externalWait = snapshot.externalWait;
  if (
    externalWait !== null &&
    now - externalWait.lastHealthyPollAtMs <= externalWait.pollIntervalMs
  ) {
    return Object.freeze({
      state: "waiting",
      lastProgressAtMs: latestProgress(snapshot),
      decision: null,
    });
  }

  const lastProgressAtMs = latestProgress(snapshot);
  const progressBaseline = lastProgressAtMs ?? snapshot.sessionStartedAtMs;
  if (now - progressBaseline <= policy.timeoutMs) {
    return Object.freeze({ state: "active", lastProgressAtMs, decision: null });
  }

  const priorAttempts = snapshot.decisions.filter(
    (decision) =>
      decision.action === policy.action && decision.reason === "no_progress",
  ).length;
  const maxAttempts = policy.maxAttempts ?? 1;
  if (priorAttempts >= maxAttempts) {
    return Object.freeze({
      state: "stalled",
      lastProgressAtMs,
      decision: null,
    });
  }
  return Object.freeze({
    state: "stalled",
    lastProgressAtMs,
    decision: Object.freeze({
      action: policy.action,
      atMs: now,
      attempt: priorAttempts + 1,
      reason: "no_progress",
    }),
  });
}

function latestProgress(snapshot: AgentProgressSnapshot): number | null {
  const values = [
    snapshot.lastModelEventAtMs,
    snapshot.lastToolEventAtMs,
    snapshot.lastWorkspaceMutationAtMs,
    snapshot.lastPhaseTransitionAtMs,
  ].filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.max(...values);
}

function validatePolicy(policy: StallPolicy): void {
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs < 0) {
    throw new RangeError(
      "stallPolicy.timeoutMs must be a finite non-negative number",
    );
  }
  if (
    policy.maxAttempts !== undefined &&
    (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1)
  ) {
    throw new RangeError(
      "stallPolicy.maxAttempts must be a positive safe integer",
    );
  }
}
