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
  /**
   * Whether a failure WITHOUT a failureClass may be retried (it is treated
   * as DEFAULT_FAILURE_CLASS when it may). Default true. Set false to retry
   * only failures an executor explicitly classified as retryable.
   */
  readonly retryUnclassified?: boolean;
  /**
   * Symmetric jitter applied to every backoff, as a fraction in [0, 1):
   * the delay is scaled by a factor in [1 - jitterRatio, 1 + jitterRatio].
   * Default 0 (deterministic). The engine supplies the random source.
   */
  readonly jitterRatio?: number;
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
 * The CLI's default automatic in-run retry: only failures an executor
 * explicitly classified as `transient_infra` (a lost git lock, a failed
 * fetch, an interrupted worker) are retried, never unclassified ones and
 * never `timeout`. `maxRetries` is the number of retries after the first
 * attempt; 0 disables retries entirely.
 */
export function transientInfraRetryPolicy(maxRetries: number): RetryPolicy {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("maxRetries must be an integer greater than or equal to 0");
  }
  if (maxRetries === 0) {
    return NO_RETRIES;
  }
  return Object.freeze({
    maxAttempts: maxRetries + 1,
    retryableClasses: new Set<FailureClass>(["transient_infra"]),
    baseDelayMs: 2_000,
    maxDelayMs: 60_000,
    retryUnclassified: false,
    jitterRatio: 0.2,
  });
}

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
 * Whether a failed outcome may be retried under `policy`.
 *
 * False for a failure adjudicated against the work (see isAdjudicated) —
 * a verdict, not bad luck — and, when `policy.retryUnclassified` is false,
 * for a failure without a failureClass. Otherwise a class membership check
 * via resolveFailureClass.
 */
export function isFailureRetryable(
  policy: RetryPolicy,
  failure: { readonly failureClass?: FailureClass; readonly cause?: unknown },
): boolean {
  if (isAdjudicated(failure)) {
    return false;
  }
  if (
    failure.failureClass === undefined &&
    policy.retryUnclassified === false
  ) {
    return false;
  }
  return isRetryable(policy, resolveFailureClass(failure));
}

/**
 * Scale a backoff by symmetric jitter: `random` returns a value in [0, 1),
 * mapped to a factor in [1 - jitterRatio, 1 + jitterRatio]. A ratio of 0
 * (or undefined) returns the delay unchanged. Rounded to whole ms.
 */
export function applyJitter(
  delayMs: number,
  jitterRatio: number | undefined,
  random: () => number,
): number {
  if (jitterRatio === undefined || jitterRatio === 0) {
    return delayMs;
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio >= 1) {
    throw new Error("jitterRatio must be a finite number in [0, 1)");
  }
  const factor = 1 + jitterRatio * (2 * random() - 1);
  return Math.max(0, Math.round(delayMs * factor));
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

/**
 * Classes a plain `resume` re-runs on a finished, failed run. Only
 * `transient_infra`: a timeout that already happened once is likely to
 * happen again, so re-running it needs an explicit rerun-node.
 */
export const RESUMABLE_FAILURE_CLASSES: ReadonlySet<FailureClass> =
  new Set<FailureClass>(["transient_infra"]);

/**
 * Whether a failure was adjudicated against the work: the executor checked
 * the pull request and found the worker's failure stands
 * (`cause.code === "WORKER_FAILURE_ADJUDICATED"`).
 */
export function isAdjudicated(failure: { readonly cause?: unknown }): boolean {
  const cause = failure.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "WORKER_FAILURE_ADJUDICATED"
  );
}

/**
 * Whether `resume` should re-run a node that ended the run in this failure.
 *
 * True for `transient_infra` (unclassified counts as transient_infra, per
 * resolveFailureClass). A failure the executor adjudicated against the pull
 * request is a verdict on the work, not bad luck, so it stays failed
 * whatever its class.
 */
export function isResumableFailure(failure: {
  readonly failureClass?: FailureClass;
  readonly cause?: unknown;
}): boolean {
  if (isAdjudicated(failure)) {
    return false;
  }
  return RESUMABLE_FAILURE_CLASSES.has(resolveFailureClass(failure));
}
