import { describe, expect, test } from "vitest";
import {
  parseWorkerPhaseUpdate,
  parseWorkerResult,
} from "../src/node/index.js";

describe("parseWorkerResult", () => {
  test("accepts a succeeded result with JSON output", () => {
    expect(
      parseWorkerResult({ status: "succeeded", output: { n: 1 } }),
    ).toEqual({ status: "succeeded", output: { n: 1 } });
  });

  test("accepts a failed result with error and class", () => {
    expect(
      parseWorkerResult({
        status: "failed",
        error: "nope",
        failureClass: "timeout",
      }),
    ).toEqual({ status: "failed", error: "nope", failureClass: "timeout" });
  });

  test("rejects an unknown status", () => {
    expect(() => parseWorkerResult({ status: "weird" })).toThrow();
  });

  test("rejects a failed result without an error string", () => {
    expect(() => parseWorkerResult({ status: "failed" })).toThrow();
  });

  test("rejects an invalid failureClass", () => {
    expect(() =>
      parseWorkerResult({
        status: "failed",
        error: "x",
        failureClass: "bogus",
      }),
    ).toThrow();
  });

  test("rejects non-JSON output", () => {
    expect(() =>
      parseWorkerResult({ status: "succeeded", output: undefined }),
    ).toThrow();
  });

  test("rejects a non-object", () => {
    expect(() => parseWorkerResult(null)).toThrow();
    expect(() => parseWorkerResult("succeeded")).toThrow();
  });
});

describe("parseWorkerPhaseUpdate", () => {
  test("accepts a supported named phase", () => {
    expect(parseWorkerPhaseUpdate({ phase: "review_wait" })).toEqual({
      phase: "review_wait",
    });
  });

  test("rejects malformed and unknown phases", () => {
    expect(() => parseWorkerPhaseUpdate(null)).toThrow();
    expect(() => parseWorkerPhaseUpdate({ phase: "thinking" })).toThrow();
  });

  test("rejects orchestrator-only phases a worker must not claim", () => {
    for (const phase of [
      "execution",
      "worktree_setup",
      "tracker_update",
      "workspace_cleanup",
    ]) {
      expect(() => parseWorkerPhaseUpdate({ phase })).toThrow();
    }
  });
});
