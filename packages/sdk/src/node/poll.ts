import { createSystemClock } from "../adapters/clock.js";
import type { GraphDefinition, JsonValue } from "../graph/types.js";
import { isPlainObject } from "../internal/json.js";
import type {
  GraphExpansionProposal,
  GraphProposalPolicy,
} from "../runtime/graph-revision.js";
import type {
  Clock,
  ExecutionContext,
  ExecutorDefinition,
  NodeExecutionOutcome,
} from "../runtime/ports.js";
import { parseImplementConfig } from "./codex-contracts.js";

/**
 * Poll mode: one long-lived run whose `poll` node watches an external
 * source and, for every item that newly satisfies the configured
 * condition, appends a frozen context node and an `implement` node through
 * an audited graph proposal. The run never finishes on its own, so
 * `prism watch` follows it like any other run and a restarted poller
 * resumes it rather than starting over.
 *
 * Sources are adapters: they decide what "matches" means and how to
 * snapshot an item. Linear is the first one.
 */

export const POLL_EXECUTOR = "poll";
export const POLL_NODE_ID = "poll";
/** Semaphore that caps concurrently running implementers in a poll run. */
export const POLL_IMPLEMENT_RESOURCE = "poll-implement";
const POLL_PROPOSER_PREFIX = "poll:";
const POLL_PROPOSAL_EXECUTORS: ReadonlySet<string> = new Set([
  "constant",
  "implement",
]);

export type PollSourceConfig = Readonly<Record<string, JsonValue>> & {
  readonly kind: string;
};

/** Something a source says currently satisfies the poll condition. */
export interface PollCandidate {
  /** Stable, source-unique key (a Linear identifier such as ENG-2142). */
  readonly key: string;
  readonly title: string;
  readonly url?: string;
}

/** An item the source did not queue, with the reason, for operator logs. */
export interface PollSkip {
  readonly key: string;
  readonly reason: string;
}

export interface PollListing {
  readonly candidates: readonly PollCandidate[];
  readonly skipped: readonly PollSkip[];
}

/** A candidate with its full, frozen task record. */
export interface PollItem extends PollCandidate {
  /** Source-suggested branch name, when the source has one. */
  readonly branchName?: string;
  /** JSON-safe snapshot handed to the implementer verbatim. */
  readonly snapshot: Readonly<Record<string, JsonValue>>;
}

export interface PollSource {
  readonly kind: string;
  /** Pure shape check of the `source` section. Throw to reject it. */
  validateConfig(config: PollSourceConfig): void;
  /** Optional credential check before a run starts; returns a description. */
  preflight?(config: PollSourceConfig, signal?: AbortSignal): Promise<string>;
  /** Items that satisfy the configured condition right now. */
  list(config: PollSourceConfig, signal: AbortSignal): Promise<PollListing>;
  /** Snapshot one candidate. Called once per newly matched item. */
  load(
    config: PollSourceConfig,
    candidate: PollCandidate,
    signal: AbortSignal,
  ): Promise<PollItem>;
}

export interface PollImplementSettings {
  readonly targetBranch: string;
  /** Used when the source has no branch name or useSourceBranchName is off. */
  readonly branchPrefix: string;
  readonly useSourceBranchName: boolean;
  /** Passed through to the implement node's review gate. */
  readonly review: Readonly<Record<string, JsonValue>>;
  readonly maxIterations?: number;
  readonly validationCommands?: readonly string[];
}

export interface PollConfig {
  readonly version: 1;
  /** Names the durable run (`poll-<name>`), so it must be stable. */
  readonly name: string;
  readonly intervalSeconds: number;
  /** Maximum implementers running at once. */
  readonly maxParallel: number;
  readonly source: PollSourceConfig;
  readonly implement: PollImplementSettings;
}

export const DEFAULT_POLL_INTERVAL_SECONDS = 300;
export const MIN_POLL_INTERVAL_SECONDS = 30;
export const DEFAULT_POLL_MAX_PARALLEL = 3;

/** The strict default gate: final 5/5, nothing actionable, green checks. */
export const DEFAULT_POLL_REVIEW: Readonly<Record<string, JsonValue>> =
  Object.freeze({
    by: "greptile",
    minConfidenceScore: 5,
    requireNoActionableFindings: true,
    requireGreenChecks: true,
  });

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "version",
  "name",
  "intervalSeconds",
  "maxParallel",
  "source",
  "implement",
]);
const IMPLEMENT_KEYS: ReadonlySet<string> = new Set([
  "targetBranch",
  "branchPrefix",
  "useSourceBranchName",
  "review",
  "maxIterations",
  "validationCommands",
]);
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Validate a poll config (the file a user writes, and the persisted config
 * of the `poll` node). Unknown keys are errors so a typo cannot silently
 * widen or disable the poll condition. Throws an Error naming the field.
 */
export function parsePollConfig(value: unknown): PollConfig {
  const config = expectObject(value, "poll config");
  rejectUnknownKeys(config, TOP_LEVEL_KEYS, "poll config");
  if (config["version"] !== undefined && config["version"] !== 1) {
    throw new Error("poll config version must be 1");
  }
  const name = config["name"];
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error(
      "poll config name must be 1-63 lowercase letters, digits, or hyphens, starting with a letter or digit",
    );
  }
  const intervalSeconds = optionalInteger(
    config["intervalSeconds"],
    "intervalSeconds",
    DEFAULT_POLL_INTERVAL_SECONDS,
  );
  if (intervalSeconds < MIN_POLL_INTERVAL_SECONDS) {
    throw new Error(
      `intervalSeconds must be at least ${String(MIN_POLL_INTERVAL_SECONDS)}`,
    );
  }
  const maxParallel = optionalInteger(
    config["maxParallel"],
    "maxParallel",
    DEFAULT_POLL_MAX_PARALLEL,
  );
  if (maxParallel < 1 || maxParallel > 32) {
    throw new Error("maxParallel must be an integer from 1 to 32");
  }

  const sourceValue = expectObject(config["source"], "source");
  const kind = sourceValue["kind"];
  if (typeof kind !== "string" || kind.trim().length === 0) {
    throw new Error("source.kind must be a non-empty string");
  }
  const source = Object.freeze({ ...sourceValue, kind }) as PollSourceConfig;

  const implementValue =
    config["implement"] === undefined
      ? {}
      : expectObject(config["implement"], "implement");
  rejectUnknownKeys(implementValue, IMPLEMENT_KEYS, "implement");
  const targetBranch = optionalString(
    implementValue["targetBranch"],
    "implement.targetBranch",
    "main",
  );
  const branchPrefix = optionalString(
    implementValue["branchPrefix"],
    "implement.branchPrefix",
    "prism/",
  );
  const useSourceBranchName = optionalBoolean(
    implementValue["useSourceBranchName"],
    "implement.useSourceBranchName",
    true,
  );
  const review =
    implementValue["review"] === undefined
      ? DEFAULT_POLL_REVIEW
      : (Object.freeze({
          ...expectObject(implementValue["review"], "implement.review"),
        }) as Readonly<Record<string, JsonValue>>);
  const maxIterations =
    implementValue["maxIterations"] === undefined
      ? undefined
      : optionalInteger(
          implementValue["maxIterations"],
          "implement.maxIterations",
          1,
        );
  const validationCommands = optionalStringList(
    implementValue["validationCommands"],
    "implement.validationCommands",
  );

  const implement: PollImplementSettings = Object.freeze({
    targetBranch,
    branchPrefix,
    useSourceBranchName,
    review,
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(validationCommands === undefined ? {} : { validationCommands }),
  });
  // Reject a bad review gate or branch setting now, not when the first
  // matching item arrives hours later.
  parseImplementConfig(
    implementNodeConfig(
      implement,
      { key: "EXAMPLE-1", title: "example" },
      kind,
    ),
  );

  return Object.freeze({
    version: 1,
    name,
    intervalSeconds,
    maxParallel,
    source,
    implement,
  });
}

/** The JSON form persisted as the `poll` node's config. */
export function pollConfigToJson(config: PollConfig): JsonValue {
  return JSON.parse(JSON.stringify(config)) as JsonValue;
}

/** The run id a poll config owns unless the operator overrides it. */
export function pollRunId(config: PollConfig): string {
  return `poll-${config.name}`;
}

/** The initial graph: one `poll` node plus the implementer semaphore. */
export function buildPollGraph(config: PollConfig): GraphDefinition {
  return {
    version: 1,
    resources: {
      [POLL_IMPLEMENT_RESOURCE]: { capacity: config.maxParallel },
    },
    nodes: {
      [POLL_NODE_ID]: {
        executor: POLL_EXECUTOR,
        kind: "task",
        dependsOn: [],
        config: pollConfigToJson(config),
      },
    },
    finalNode: POLL_NODE_ID,
  };
}

export interface PollNodeIds {
  readonly contextNodeId: string;
  readonly implementNodeId: string;
}

export function pollNodeIds(sourceKind: string, key: string): PollNodeIds {
  const slug = slugify(`${sourceKind}-${key}`);
  return {
    contextNodeId: `context-${slug}`,
    implementNodeId: `implement-${slug}`,
  };
}

/** The idempotency key for one item: replaying it never appends twice. */
export function pollProposalId(sourceKind: string, key: string): string {
  return `${POLL_PROPOSER_PREFIX}${sourceKind}:${key}`;
}

/**
 * The expansion for one item: a `constant` node holding the frozen
 * snapshot (the implementer's first input, exactly like a Beads context
 * node) and an `implement` node gated by the poll semaphore.
 */
export function buildPollProposal(
  config: PollConfig,
  item: PollItem,
  proposerNodeId: string,
): GraphExpansionProposal {
  const kind = config.source.kind;
  const { contextNodeId, implementNodeId } = pollNodeIds(kind, item.key);
  return {
    id: pollProposalId(kind, item.key),
    proposer: `${POLL_PROPOSER_PREFIX}${proposerNodeId}`,
    nodes: {
      [contextNodeId]: {
        executor: "constant",
        kind: "task",
        dependsOn: [],
        config: { value: { ...item.snapshot, provider: kind, id: item.key } },
      },
      [implementNodeId]: {
        executor: "implement",
        kind: "task",
        dependsOn: [contextNodeId],
        resources: [POLL_IMPLEMENT_RESOURCE],
        config: implementNodeConfig(config.implement, item, kind),
      },
    },
    rationale: {
      source: kind,
      key: item.key,
      title: item.title,
      ...(item.url === undefined ? {} : { url: item.url }),
    },
  };
}

/**
 * Accept only what a poller is allowed to add: context snapshots and
 * implementers, proposed by a `poll` node. Everything else keeps the
 * engine's default of rejecting dynamic expansion.
 */
export const pollGraphProposalPolicy: GraphProposalPolicy = (proposal) => {
  if (!proposal.proposer.startsWith(POLL_PROPOSER_PREFIX)) {
    return {
      status: "rejected",
      policy: "poll",
      reason: "only poll nodes may expand this graph",
    };
  }
  for (const [nodeId, node] of Object.entries(proposal.nodes)) {
    if (!POLL_PROPOSAL_EXECUTORS.has(node.executor)) {
      return {
        status: "rejected",
        policy: "poll",
        reason: `poll proposals may not add executor "${node.executor}" (node "${nodeId}")`,
      };
    }
  }
  return { status: "accepted", policy: "poll" };
};

export interface PollExecutorOptions {
  readonly sources: readonly PollSource[];
  /** Waits between polls. Default: the system clock. */
  readonly clock?: Clock;
  /** Operator-facing progress lines. Never receives credentials. */
  readonly log?: (line: string) => void;
}

export function createPollExecutor(
  options: PollExecutorOptions,
): ExecutorDefinition {
  const sources = new Map(
    options.sources.map((source) => [source.kind, source]),
  );
  const clock = options.clock ?? createSystemClock();

  function sourceFor(config: PollConfig): PollSource {
    const source = sources.get(config.source.kind);
    if (source === undefined) {
      throw new Error(
        `unknown poll source "${config.source.kind}"; available: ${[...sources.keys()].join(", ") || "none"}`,
      );
    }
    return source;
  }

  return Object.freeze({
    name: POLL_EXECUTOR,
    validateConfig(value: JsonValue | undefined): void {
      const config = parsePollConfig(value);
      sourceFor(config).validateConfig(config.source);
    },
    async execute(context: ExecutionContext): Promise<NodeExecutionOutcome> {
      const config = parsePollConfig(context.config);
      const source = sourceFor(config);
      const submit = context.submitGraphProposal;
      if (submit === undefined) return expansionUnavailable();
      const log = (line: string): void => {
        options.log?.(`poll ${config.name}: ${line}`);
      };
      // Keys already proposed in this session. A resumed session starts
      // empty and re-submits; proposal ids make that replay a no-op.
      const proposed = new Set<string>();
      const reportedSkips = new Map<string, string>();
      // Stores stamp revisions with wall-clock time. A replayed proposal
      // returns a revision decided before this session began.
      const sessionStartedAtMs = Date.now();

      while (!context.signal.aborted) {
        try {
          const listing = await source.list(config.source, context.signal);
          for (const skip of listing.skipped) {
            if (reportedSkips.get(skip.key) !== skip.reason) {
              reportedSkips.set(skip.key, skip.reason);
              log(`skipping ${skip.key}: ${skip.reason}`);
            }
          }
          let queued = 0;
          for (const candidate of listing.candidates) {
            if (proposed.has(candidate.key) || context.signal.aborted) continue;
            try {
              const item = await source.load(
                config.source,
                candidate,
                context.signal,
              );
              const result = await submit(
                buildPollProposal(config, item, context.nodeId),
              );
              if (
                result.status === "rejected" &&
                result.revision.decision.policy ===
                  ENGINE_EXPANSION_DISABLED_POLICY
              ) {
                return expansionUnavailable();
              }
              proposed.add(candidate.key);
              reportedSkips.delete(candidate.key);
              if (
                result.status === "accepted" &&
                result.revision.timestampMs < sessionStartedAtMs
              ) {
                log(`already queued ${candidate.key}: ${candidate.title}`);
              } else if (result.status === "accepted") {
                queued += 1;
                log(`queued ${candidate.key}: ${candidate.title}`);
              } else {
                const decision = result.revision.decision;
                log(
                  `rejected ${candidate.key}: ${decision.status === "rejected" ? decision.reason : "unknown reason"}`,
                );
              }
            } catch (error: unknown) {
              if (context.signal.aborted) break;
              log(`could not queue ${candidate.key}: ${describe(error)}`);
            }
          }
          log(
            `${String(listing.candidates.length)} matching, ${String(queued)} newly queued`,
          );
        } catch (error: unknown) {
          if (context.signal.aborted) break;
          log(`poll failed, retrying next interval: ${describe(error)}`);
        }
        try {
          await clock.wait(config.intervalSeconds * 1_000, context.signal);
        } catch {
          break;
        }
      }
      return { status: "failed", cause: { code: "POLL_STOPPED" } };
    },
  });
}

/** The policy name of the engine's default, expansion-disabled gate. */
const ENGINE_EXPANSION_DISABLED_POLICY = "disabled";

function expansionUnavailable(): NodeExecutionOutcome {
  return {
    status: "failed",
    cause: {
      code: "POLL_EXPANSION_UNAVAILABLE",
      message:
        "this engine does not accept graph proposals; run poll nodes with pollGraphProposalPolicy",
    },
    failureClass: "policy_denied",
  };
}

function implementNodeConfig(
  implement: PollImplementSettings,
  item: Pick<PollItem, "key" | "title" | "url" | "branchName">,
  sourceKind: string,
): JsonValue {
  const branchName =
    implement.useSourceBranchName &&
    item.branchName !== undefined &&
    item.branchName.trim().length > 0
      ? item.branchName.trim()
      : `${implement.branchPrefix}${slugify(item.key)}`;
  return {
    workItem: {
      provider: sourceKind,
      id: item.key,
      title: item.title,
      ...(item.url === undefined ? {} : { url: item.url }),
    },
    targetBranch: implement.targetBranch,
    branchName,
    review: implement.review,
    ...(implement.maxIterations === undefined
      ? {}
      : { maxIterations: implement.maxIterations }),
    ...(implement.validationCommands === undefined
      ? {}
      : { validationCommands: [...implement.validationCommands] }),
  };
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new Error(`cannot derive a node id from "${value}"`);
  }
  return slug;
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
}

function expectObject(
  value: unknown,
  field: string,
): Record<string, JsonValue> {
  if (!isPlainObject(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function rejectUnknownKeys(
  value: Record<string, JsonValue>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${field} has unknown key "${key}"`);
    }
  }
}

function optionalInteger(
  value: JsonValue | undefined,
  field: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function optionalString(
  value: JsonValue | undefined,
  field: string,
  fallback: string,
): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoolean(
  value: JsonValue | undefined,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function optionalStringList(
  value: JsonValue | undefined,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return Object.freeze([...(value as string[])]);
}
