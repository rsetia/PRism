import { describe, expect, test } from "vitest";
import { formatSpan } from "../src/stats-format.js";

describe("formatSpan", () => {
  test.each([
    [0, "0s"],
    [45_000, "45s"],
    [59_600, "1.0m"],
    [12.5 * 60_000, "12.5m"],
    [3_597_000, "1.0h"],
    [3.25 * 3_600_000, "3.3h"],
  ])("%d ms prints as %s", (durationMs, expected) => {
    expect(formatSpan(durationMs)).toBe(expected);
  });
});
