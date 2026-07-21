import { describe, expect, test } from "vitest";
import {
  computeBackoffMs,
  isRetryable,
  NO_RETRIES,
  resolveFailureClass,
  RETRY_TRANSIENT,
} from "../src/index.js";
import type { FailureClass, RetryPolicy } from "../src/index.js";

const policy: RetryPolicy = {
  maxAttempts: 5,
  retryableClasses: new Set<FailureClass>(["transient_infra", "timeout"]),
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

describe("resolveFailureClass", () => {
  test("uses the executor's class when it gave one", () => {
    expect(resolveFailureClass({ failureClass: "merge_conflict" })).toBe(
      "merge_conflict",
    );
  });

  test("unclassified failures default to transient_infra", () => {
    expect(resolveFailureClass({})).toBe("transient_infra");
  });
});

describe("isRetryable", () => {
  test("only classes in the policy retry", () => {
    expect(isRetryable(policy, "transient_infra")).toBe(true);
    expect(isRetryable(policy, "timeout")).toBe(true);
    expect(isRetryable(policy, "semantic_failed")).toBe(false);
    expect(isRetryable(policy, "policy_denied")).toBe(false);
  });

  test("NO_RETRIES retries nothing", () => {
    const classes: readonly FailureClass[] = [
      "transient_infra",
      "timeout",
      "validation_failed",
      "semantic_failed",
      "merge_conflict",
      "policy_denied",
      "manual_review_required",
    ];
    for (const failureClass of classes) {
      expect(isRetryable(NO_RETRIES, failureClass)).toBe(false);
    }
  });

  test("RETRY_TRANSIENT retries only infra and timeout", () => {
    expect(isRetryable(RETRY_TRANSIENT, "transient_infra")).toBe(true);
    expect(isRetryable(RETRY_TRANSIENT, "timeout")).toBe(true);
    expect(isRetryable(RETRY_TRANSIENT, "validation_failed")).toBe(false);
  });
});

describe("computeBackoffMs", () => {
  test("doubles per attempt, then clamps to maxDelayMs", () => {
    expect(computeBackoffMs(policy, 1)).toBe(100);
    expect(computeBackoffMs(policy, 2)).toBe(200);
    expect(computeBackoffMs(policy, 3)).toBe(400);
    expect(computeBackoffMs(policy, 4)).toBe(800);
    expect(computeBackoffMs(policy, 5)).toBe(1_000);
    expect(computeBackoffMs(policy, 50)).toBe(1_000);
  });

  test("is deterministic — no hidden jitter", () => {
    expect(computeBackoffMs(policy, 3)).toBe(computeBackoffMs(policy, 3));
  });

  test("a zero base delay stays zero", () => {
    const instant: RetryPolicy = { ...policy, baseDelayMs: 0 };
    expect(computeBackoffMs(instant, 1)).toBe(0);
    expect(computeBackoffMs(instant, 4)).toBe(0);
  });

  test("rejects a non-positive attempt as API misuse", () => {
    expect(() => computeBackoffMs(policy, 0)).toThrow();
    expect(() => computeBackoffMs(policy, -1)).toThrow();
  });
});
