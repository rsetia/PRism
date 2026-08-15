import type { PersistedRunEvent, UsageReport } from "./events.js";

export interface AttemptUsage {
  readonly nodeId: string;
  readonly attempt: number;
  readonly usage: UsageReport;
}

export interface UsageTotals {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly agentTurns: number | null;
  readonly toolCalls: number | null;
  readonly costUsd: number | null;
  readonly costKind: "authoritative" | "estimated" | "unknown";
  readonly attempts: readonly AttemptUsage[];
}

/** Aggregate append-only usage without inventing zeros for absent capability. */
export function summarizeUsage(
  events: readonly PersistedRunEvent[],
): UsageTotals | null {
  const attempts = events.flatMap((event): AttemptUsage[] =>
    event.kind === "node_usage_reported"
      ? [{ nodeId: event.nodeId, attempt: event.attempt, usage: event.usage }]
      : [],
  );
  if (attempts.length === 0) return null;
  const total = (key: keyof UsageReport): number | null => {
    const values = attempts
      .map(({ usage }) => usage[key])
      .filter((value): value is number => typeof value === "number");
    return values.length === 0
      ? null
      : values.reduce((sum, value) => sum + value, 0);
  };
  const costUsd = total("costUsd");
  return Object.freeze({
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    cachedTokens: total("cachedTokens"),
    agentTurns: total("agentTurns"),
    toolCalls: total("toolCalls"),
    costUsd,
    costKind: costUsd === null ? "unknown" : "authoritative",
    attempts: Object.freeze(attempts),
  });
}
