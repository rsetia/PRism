import type { FailureClass } from "./types.js";

/**
 * Retry configuration as data, and the pure functions that read it
 * (plan §11). Deciding a retry is arithmetic over (policy, attempt,
 * failure class) — no clock, no I/O. Actually *waiting* is the Clock
 * port's job, which is what keeps retry tests instant.
 */
export interface RetryPolicy {
  /** Total attempts per node, including the first. Integer >= 1. */
  readonly maxAttempts: number;
  /** Failure classes worth retrying; everything else fails immediately. */
  readonly retryableClasses: ReadonlySet<FailureClass>;
  /** Delay before the first retry, in milliseconds. */
  readonly baseDelayMs: number;
  /** Ceiling for exponential growth, in milliseconds. */
  readonly maxDelayMs: number;
}

/** The engine default: one attempt, no retries — current behavior. */
export const NO_RETRIES: RetryPolicy = Object.freeze({
  maxAttempts: 1,
  retryableClasses: new Set<FailureClass>(),
  baseDelayMs: 0,
  maxDelayMs: 0,
});

/** A sensible starting point: retry only what is plausibly unlucky. */
export const RETRY_TRANSIENT: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  retryableClasses: new Set<FailureClass>(["transient_infra", "timeout"]),
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
});

/**
 * The class an unclassified failure is treated as. Unclassified means
 * "the executor did not say" — most often a thrown value the engine
 * normalized — and an infrastructure blip is the likeliest cause.
 */
export const DEFAULT_FAILURE_CLASS: FailureClass = "transient_infra";

/**
 * The class to use when deciding retries for a failed outcome.
 *
 * Returns `failed.failureClass` when present, otherwise
 * DEFAULT_FAILURE_CLASS. This never rewrites the recorded failure — an
 * unclassified failure stays unclassified in the event log.
 */
export function resolveFailureClass(failed: {
  readonly failureClass?: FailureClass;
}): FailureClass {
  return failed.failureClass ?? DEFAULT_FAILURE_CLASS;
}

/**
 * Whether a failure of this class may be retried at all.
 *
 * This is a direct membership check in policy.retryableClasses.
 */
export function isRetryable(
  policy: RetryPolicy,
  failureClass: FailureClass,
): boolean {
  return policy.retryableClasses.has(failureClass);
}

/**
 * Backoff before the retry that follows `attempt` (1-based: attempt 1
 * just failed, so this is the wait before attempt 2).
 *
 * Exponential — baseDelayMs * 2^(attempt - 1) — clamped to maxDelayMs.
 * Throws for attempt < 1 (invalid API use). Deterministic on purpose:
 * jitter needs an injected random source, and that is a later decision,
 * not a Math.random sprinkled here.
 */
export function computeBackoffMs(policy: RetryPolicy, attempt: number): number {
  if (attempt < 1) {
    throw new Error("attempt must be greater than or equal to 1");
  }
  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
}
