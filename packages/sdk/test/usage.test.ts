import { describe, expect, test } from "vitest";
import { summarizeUsage } from "../src/runtime/usage.js";
import type { PersistedRunEvent, UsageReport } from "../src/index.js";

function usage(attempt: number, report: UsageReport): PersistedRunEvent {
  return {
    kind: "node_usage_reported",
    nodeId: "work",
    attempt,
    usage: report,
    seq: attempt,
    timestampMs: attempt,
  };
}

describe("summarizeUsage", () => {
  test("returns null without usage events", () => {
    expect(summarizeUsage([])).toBeNull();
  });

  test("keeps partial metrics unknown and skips token-less events during estimation", () => {
    const result = summarizeUsage(
      [
        usage(1, { provider: "fake", inputTokens: 10, costUsd: 0.5 }),
        usage(2, { provider: "fake", inputTokens: 20 }),
        usage(3, { agentTurns: 1 }),
      ],
      [{ version: "v1", provider: "fake", inputPerMillion: 1 }],
    );
    expect(result).toMatchObject({
      inputTokens: null,
      agentTurns: null,
      costUsd: 0.50002,
      costKind: "estimated",
      priceVersion: "v1",
    });
  });

  test("returns unknown cost when a token-bearing attempt has no matching price", () => {
    const result = summarizeUsage([
      usage(1, { provider: "unknown", inputTokens: 1 }),
    ]);
    expect(result).toMatchObject({ costUsd: null, costKind: "unknown" });
  });

  test("does not present an authoritative lower bound as the run cost", () => {
    const result = summarizeUsage([
      usage(1, { costUsd: 0.5 }),
      usage(2, { provider: "unknown", inputTokens: 1 }),
    ]);
    expect(result).toMatchObject({ costUsd: null, costKind: "unknown" });
  });
});
