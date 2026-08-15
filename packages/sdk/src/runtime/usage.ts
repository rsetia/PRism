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
  /** Version of configured pricing used for an estimated cost. */
  readonly priceVersion: string | null;
  readonly attempts: readonly AttemptUsage[];
}

/** Versioned USD token pricing. Costs derived from this metadata are estimates. */
export interface UsagePriceMetadata {
  readonly version: string;
  readonly provider?: string;
  readonly model?: string;
  readonly inputPerMillion?: number;
  readonly outputPerMillion?: number;
  readonly cachedPerMillion?: number;
}

/** Aggregate append-only usage without inventing zeros for absent capability. */
export function summarizeUsage(
  events: readonly PersistedRunEvent[],
  prices: readonly UsagePriceMetadata[] = [],
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
  let estimatedCost = 0;
  let priceVersion: string | null = null;
  let hasTokenUsage = false;
  for (const { usage } of attempts) {
    const price = prices.find(
      (candidate) =>
        (candidate.provider === undefined ||
          candidate.provider === usage.provider) &&
        (candidate.model === undefined || candidate.model === usage.model),
    );
    const priced =
      price !== undefined &&
      (usage.inputTokens === undefined ||
        price.inputPerMillion !== undefined) &&
      (usage.outputTokens === undefined ||
        price.outputPerMillion !== undefined) &&
      (usage.cachedTokens === undefined ||
        price.cachedPerMillion !== undefined);
    if (!priced || price === undefined) {
      priceVersion = null;
      hasTokenUsage = false;
      break;
    }
    if (priceVersion !== null && priceVersion !== price.version) {
      priceVersion = null;
      hasTokenUsage = false;
      break;
    }
    priceVersion = price.version;
    hasTokenUsage ||=
      usage.inputTokens !== undefined ||
      usage.outputTokens !== undefined ||
      usage.cachedTokens !== undefined;
    estimatedCost +=
      ((usage.inputTokens ?? 0) * (price.inputPerMillion ?? 0) +
        (usage.outputTokens ?? 0) * (price.outputPerMillion ?? 0) +
        (usage.cachedTokens ?? 0) * (price.cachedPerMillion ?? 0)) /
      1_000_000;
  }
  const derivedCost =
    hasTokenUsage && priceVersion !== null ? estimatedCost : null;
  return Object.freeze({
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    cachedTokens: total("cachedTokens"),
    agentTurns: total("agentTurns"),
    toolCalls: total("toolCalls"),
    costUsd: costUsd ?? derivedCost,
    costKind:
      costUsd === null
        ? derivedCost === null
          ? "unknown"
          : "estimated"
        : "authoritative",
    priceVersion: costUsd === null ? priceVersion : null,
    attempts: Object.freeze(attempts),
  });
}
