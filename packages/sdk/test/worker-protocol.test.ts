import { describe, expect, test } from "vitest";
import { parseWorkerResult } from "../src/node/index.js";

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
