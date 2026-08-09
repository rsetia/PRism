import type { GraphDefinition, JsonValue } from "../graph/types.js";
import { isJsonValue, isPlainObject } from "../internal/json.js";

/**
 * The Beads DAG generator (plan §15): turn `bd` issue data into a graph
 * the SDK can run. This is the payoff of building for dynamic graphs —
 * a bead list maps almost 1:1 onto node definitions, so "orchestrate my
 * Beads backlog" is a pure data transformation, not a new engine.
 *
 * Pure and Node-free: parsing a JSONL string and emitting a graph needs
 * no filesystem. Reading `bd list --json` from the CLI is a thin wrapper
 * layered on top (a §16 / CLI concern), not part of this module.
 */

/**
 * A bead as `bd` emits it — only the fields the generator reads are
 * named; the rest ride along in the index signature so nothing is lost.
 */
export interface Bead {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly status?: string;
  /** IDs of beads this one depends on. */
  readonly dependencies?: readonly string[];
  readonly [key: string]: unknown;
}

/** Which review gate the generated implement nodes use. */
export type ReviewGate = "greptile" | "claude" | "none";

/**
 * Review-loop settings copied into every generated implement node.
 * Kept in the Node-free graph layer so Beads DAGs can be authored without
 * importing the Node-only Codex executor entry point.
 */
export interface BeadsReviewConfig {
  readonly by: ReviewGate;
  readonly greptileAppSlug?: string;
  readonly minConfidenceScore?: number;
  readonly requireApproved?: boolean;
  readonly requireNoActionableFindings?: boolean;
  readonly requireGreenChecks?: boolean;
  readonly allowConfidenceFourWithoutActionableFindings?: boolean;
  readonly triggerComment?: string;
}

/**
 * A spec/RFC document frozen verbatim into every generated context node.
 * Workers cannot read the Beads database or repository docs at task time —
 * the graph node is their entire context — so a bead that merely names its
 * spec hands the worker a name, not the contracts. Embedding the document
 * makes the contracts reach the worker even when a bead paraphrases them.
 */
export interface BeadsSpecDocument {
  /** Provenance, e.g. the file path the content was read from. */
  readonly source?: string;
  readonly content: string;
}

export interface FinalPullRequestOptions {
  /** Base branch for the final integration PR (for example, "main"). */
  readonly targetBranch: string;
  /** Review gate for the final current-head review/fix loop. */
  readonly review: ReviewGate;
  readonly reviewConfig?: Omit<BeadsReviewConfig, "by">;
  readonly validationCommands?: readonly string[];
  readonly maxIterations?: number;
  /** Create or retain the final PR as a draft. Default false. */
  readonly draft?: boolean;
  readonly title?: string;
  readonly body?: string;
}

export interface BeadsGraphOptions {
  /** Spec document embedded into every context node as `specDocument`. */
  readonly spec?: BeadsSpecDocument;
  /** Branch PRs target. Default "main". */
  readonly targetBranch?: string;
  /** Review gate for every implement node. Default "none". */
  readonly review?: ReviewGate;
  /** Detailed review-loop settings; `by` defaults to `review` or "none". */
  readonly reviewConfig?: Omit<BeadsReviewConfig, "by">;
  /** Prefix for generated feature branch names. Default "prism/". */
  readonly branchPrefix?: string;
  /** Validation commands run by every implement node. */
  readonly validationCommands?: readonly string[];
  /** Maximum implementation/review iterations. Default 8 in the executor. */
  readonly maxIterations?: number;
  /** Add a merge_resolve node after each implement. Default true. */
  readonly includeMerge?: boolean;
  /** Validation commands run after merge conflict resolution. */
  readonly mergeValidationCommands?: readonly string[];
  /** Serialize merge/update chains while implementations fan out. Default true. */
  readonly serializeMerges?: boolean;
  /** Add a beads_update node after each merge. Default true. */
  readonly includeBeadsUpdate?: boolean;
  /** Passed to beads_update nodes so they know where to run `bd`. */
  readonly beadsRepo?: string;
  /** Append a reviewed integration PR from targetBranch into this base. */
  readonly finalPullRequest?: FinalPullRequestOptions;
}

/**
 * Parse `bd`'s JSON-lines output into beads.
 */
export function parseBeadsJsonl(text: string): readonly Bead[] {
  const beads: Bead[] = [];
  const lines = text.split(/\r\n|\n|\r/);

  for (const [index, source] of lines.entries()) {
    const line = source.trim();
    if (line.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error: unknown) {
      throw new Error(
        `Invalid Beads JSONL at line ${String(index + 1)}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (
      !isPlainObject(parsed) ||
      typeof parsed["id"] !== "string" ||
      parsed["id"].trim().length === 0
    ) {
      throw new Error(
        `Invalid Beads JSONL at line ${String(index + 1)}: expected an object with a non-empty string id`,
      );
    }

    const dependencies = normalizeDependencies([
      parsed["dependencies"],
      parsed["depends_on"],
      parsed["dependsOn"],
      parsed["blocked_by"],
      parsed["blockedBy"],
      parsed["blockers"],
    ]);
    beads.push(
      Object.freeze({
        ...parsed,
        id: parsed["id"].trim(),
        dependencies: Object.freeze(dependencies),
      }),
    );
  }

  return Object.freeze(beads);
}

/**
 * Build a runnable graph from a set of beads. The result is a
 * GraphDefinition ready for compileGraph — and, serialized, valid input
 * for parseGraph.
 */
export function buildBeadsGraph(
  beads: readonly Bead[],
  options?: BeadsGraphOptions,
): GraphDefinition {
  if (beads.length === 0) {
    throw new Error("Cannot build a Beads graph from an empty bead set");
  }

  const targetBranch = options?.targetBranch ?? "main";
  const review = options?.review ?? "greptile";
  const branchPrefix = options?.branchPrefix ?? "prism/";
  const validationCommands = options?.validationCommands;
  const maxIterations = options?.maxIterations;
  const includeMerge = options?.includeMerge ?? true;
  const mergeValidationCommands = options?.mergeValidationCommands;
  const serializeMerges = options?.serializeMerges ?? true;
  const includeBeadsUpdate = options?.includeBeadsUpdate ?? true;
  const spec = options?.spec;
  if (spec !== undefined) {
    if (typeof spec.content !== "string" || spec.content.trim().length === 0) {
      throw new Error("spec.content must be a non-empty string");
    }
    if (
      spec.source !== undefined &&
      (typeof spec.source !== "string" || spec.source.trim().length === 0)
    ) {
      throw new Error("spec.source must be a non-empty string when present");
    }
  }
  validateOptions(
    targetBranch,
    review,
    branchPrefix,
    options?.reviewConfig,
    validationCommands,
    maxIterations,
    includeMerge,
    mergeValidationCommands,
    serializeMerges,
    includeBeadsUpdate,
    options?.beadsRepo,
    options?.finalPullRequest,
  );
  const reviewConfig = {
    by: review,
    ...defaultTriggerComment(review),
    ...options?.reviewConfig,
    ...(options?.reviewConfig?.greptileAppSlug === undefined
      ? {}
      : { greptileAppSlug: options.reviewConfig.greptileAppSlug.trim() }),
  };

  interface BeadPlan {
    readonly bead: Bead;
    readonly slug: string;
    readonly dependencies: readonly string[];
    readonly contextNodeId: string;
    readonly implementNodeId: string;
    readonly mergeNodeId: string;
    readonly updateNodeId: string;
  }

  const plansById = new Map<string, BeadPlan>();
  const beadIdBySlug = new Map<string, string>();
  for (const bead of beads) {
    const id = normalizeBeadId(bead.id);
    if (plansById.has(id)) {
      throw new Error(`Duplicate Beads id: "${id}"`);
    }

    const beadSlug = slug(id);
    const collidingId = beadIdBySlug.get(beadSlug);
    if (collidingId !== undefined) {
      throw new Error(
        `Beads ids "${collidingId}" and "${id}" collide after slugging to "${beadSlug}"`,
      );
    }
    beadIdBySlug.set(beadSlug, id);

    const dependencies = normalizeBuildDependencies(bead.dependencies, id);
    plansById.set(id, {
      bead: id === bead.id ? bead : { ...bead, id },
      slug: beadSlug,
      dependencies,
      contextNodeId: `context-${beadSlug}`,
      implementNodeId: `implement-${beadSlug}`,
      mergeNodeId: `merge-${beadSlug}`,
      updateNodeId: `update-${beadSlug}`,
    });
  }

  for (const plan of plansById.values()) {
    for (const dependencyId of plan.dependencies) {
      if (!plansById.has(dependencyId)) {
        throw new Error(
          `Bead "${plan.bead.id}" depends on unknown bead "${dependencyId}"`,
        );
      }
    }
  }

  const orderedPlans = topologicalPlans(plansById);
  const nodes: Record<string, GraphDefinition["nodes"][string]> = {};
  const terminalNodeIds: string[] = [];
  let previousSerializedNodeId: string | undefined;

  for (const plan of orderedPlans) {
    nodes[plan.contextNodeId] = {
      executor: "constant",
      kind: "task",
      dependsOn: [],
      config: { value: beadContext(plan.bead, plan.dependencies, spec) },
    };
    const workItem = {
      provider: "beads",
      id: plan.bead.id,
      url: `beads://${plan.bead.id}`,
      ...(typeof plan.bead.title === "string"
        ? { title: plan.bead.title }
        : {}),
    };
    const dependencyNodes = plan.dependencies.map((dependencyId) => {
      const dependency = plansById.get(dependencyId);
      if (dependency === undefined) {
        throw new Error(
          `Bead "${plan.bead.id}" lost dependency "${dependencyId}"`,
        );
      }
      return includeMerge ? dependency.mergeNodeId : dependency.implementNodeId;
    });

    nodes[plan.implementNodeId] = {
      executor: "implement",
      kind: "task",
      // The full Beads record is always the first input. Any dependency
      // results follow it in stable bead-dependency order.
      dependsOn: [plan.contextNodeId, ...dependencyNodes],
      config: {
        workItem,
        targetBranch,
        branchName: `${branchPrefix}${plan.slug}`,
        review: reviewConfig,
        ...(maxIterations === undefined ? {} : { maxIterations }),
        ...(validationCommands === undefined ? {} : { validationCommands }),
      },
    };

    let terminalNodeId = plan.implementNodeId;
    if (includeMerge) {
      const mergeDependencies = [plan.implementNodeId];
      if (
        serializeMerges &&
        previousSerializedNodeId !== undefined &&
        !mergeDependencies.includes(previousSerializedNodeId)
      ) {
        mergeDependencies.push(previousSerializedNodeId);
      }
      nodes[plan.mergeNodeId] = {
        executor: "merge_resolve",
        kind: "task",
        dependsOn: mergeDependencies,
        config: {
          targetBranch,
          sourceBranchFrom: plan.implementNodeId,
          mergeMethod: "squash",
          ...(mergeValidationCommands === undefined
            ? {}
            : { validationCommands: mergeValidationCommands }),
        },
      };
      terminalNodeId = plan.mergeNodeId;
    }

    if (includeBeadsUpdate) {
      nodes[plan.updateNodeId] = {
        executor: "beads_update",
        kind: "task",
        dependsOn: [terminalNodeId],
        config: {
          beadId: plan.bead.id,
          ...(options?.beadsRepo === undefined
            ? {}
            : { beadsRepo: options.beadsRepo }),
        },
      };
      terminalNodeId = plan.updateNodeId;
    }
    if (includeMerge && serializeMerges) {
      previousSerializedNodeId = terminalNodeId;
    }
    terminalNodeIds.push(terminalNodeId);
  }

  let completionNode: string;
  if (terminalNodeIds.length === 1) {
    const onlyTerminal = terminalNodeIds[0];
    if (onlyTerminal === undefined) {
      throw new Error("Beads graph lost its final node");
    }
    completionNode = onlyTerminal;
  } else {
    completionNode = "beads-final";
    nodes[completionNode] = {
      // A constant node is a barrier here: the scheduler still waits for
      // every terminal, while the output remains structured JSON regardless
      // of the shapes returned by implement/merge/update executors.
      executor: "constant",
      kind: "merge",
      dependsOn: terminalNodeIds,
      config: {
        value: {
          completedBeads: orderedPlans.map((plan) => plan.bead.id),
        },
      },
    };
  }

  const finalPullRequest = options?.finalPullRequest;
  if (finalPullRequest === undefined) {
    return { version: 1, nodes, finalNode: completionNode };
  }
  const finalNode = "finalize-integration-pr";
  nodes[finalNode] = {
    executor: "finalize_pr",
    kind: "task",
    dependsOn: [completionNode],
    config: {
      sourceBranch: targetBranch,
      targetBranch: finalPullRequest.targetBranch,
      review: {
        by: finalPullRequest.review,
        ...defaultTriggerComment(finalPullRequest.review),
        ...finalPullRequest.reviewConfig,
      },
      ...(finalPullRequest.validationCommands === undefined
        ? {}
        : { validationCommands: finalPullRequest.validationCommands }),
      ...(finalPullRequest.maxIterations === undefined
        ? {}
        : { maxIterations: finalPullRequest.maxIterations }),
      ...(finalPullRequest.draft === undefined
        ? {}
        : { draft: finalPullRequest.draft }),
      ...(finalPullRequest.title === undefined
        ? {}
        : { title: finalPullRequest.title }),
      ...(finalPullRequest.body === undefined
        ? {}
        : { body: finalPullRequest.body }),
    },
  };
  return { version: 1, nodes, finalNode };
}

function beadContext(
  bead: Bead,
  dependencies: readonly string[],
  spec?: BeadsSpecDocument,
): JsonValue {
  const value: unknown = bead;
  if (!isJsonValue(value) || !isPlainObject(value)) {
    throw new Error(`Bead "${bead.id}" must contain only JSON-safe data`);
  }
  return {
    ...value,
    provider: "beads",
    id: bead.id,
    url: `beads://${bead.id}`,
    dependencies: [...dependencies],
    // Spread last so a bead field named specDocument cannot shadow the
    // shared spec the operator asked to freeze into every node.
    ...(spec === undefined
      ? {}
      : {
          specDocument: {
            ...(spec.source === undefined ? {} : { source: spec.source }),
            content: spec.content,
          },
        }),
  };
}

const HARD_DEPENDENCY_TYPES: ReadonlySet<string> = new Set([
  "blocks",
  "blocked_by",
  "depends_on",
  "dependency",
  "requires",
]);

const DEPENDENCY_ID_PROPERTIES = [
  // `bd export` relationship records identify the current issue with
  // issue_id and the actual prerequisite with depends_on_id. Prefer the
  // directional fields so a relationship never becomes a self-cycle.
  "depends_on_id",
  "dependsOnId",
  "dependency_id",
  "dependencyId",
  "blocker_id",
  "blockerId",
  // `bd show --long` emits hydrated dependency records with `id`.
  "id",
  "bead_id",
  "beadId",
  "issue_id",
  "issueId",
  "source_id",
  "sourceId",
] as const;

function normalizeDependencies(value: unknown): string[] {
  const entries = flattenDependencyEntries(value);
  const dependencies: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const dependencyId = dependencyIdFrom(entry);
    if (dependencyId === undefined || seen.has(dependencyId)) {
      continue;
    }
    seen.add(dependencyId);
    dependencies.push(dependencyId);
  }
  return dependencies;
}

function flattenDependencyEntries(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [value];
  }
  return value.flatMap((entry) =>
    Array.isArray(entry) ? flattenDependencyEntries(entry) : [entry],
  );
}

function dependencyIdFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id.length === 0 ? undefined : id;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const relationshipType = firstStringProperty(value, [
    "type",
    "relation",
    "dependency_type",
    "dependencyType",
  ]);
  if (
    relationshipType !== undefined &&
    !HARD_DEPENDENCY_TYPES.has(relationshipType.toLowerCase())
  ) {
    return undefined;
  }
  for (const property of DEPENDENCY_ID_PROPERTIES) {
    const candidate = value[property];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function firstStringProperty(
  value: Readonly<Record<string, unknown>>,
  properties: readonly string[],
): string | undefined {
  for (const property of properties) {
    const candidate = value[property];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function normalizeBeadId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Every bead must have a non-empty string id");
  }
  return value.trim();
}

function normalizeBuildDependencies(
  value: readonly string[] | undefined,
  beadId: string,
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Bead "${beadId}" dependencies must be an array`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const dependency of value as readonly unknown[]) {
    if (typeof dependency !== "string" || dependency.trim().length === 0) {
      throw new Error(
        `Bead "${beadId}" dependencies must contain non-empty strings`,
      );
    }
    const dependencyId = dependency.trim();
    if (!seen.has(dependencyId)) {
      seen.add(dependencyId);
      normalized.push(dependencyId);
    }
  }
  return normalized;
}

function topologicalPlans<
  T extends { readonly dependencies: readonly string[] },
>(plansById: ReadonlyMap<string, T>): readonly T[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: T[] = [];

  function visit(beadId: string): void {
    if (visited.has(beadId)) {
      return;
    }
    if (visiting.has(beadId)) {
      throw new Error(`Cycle detected in Beads dependencies at "${beadId}"`);
    }
    const plan = plansById.get(beadId);
    if (plan === undefined) {
      throw new Error(`Unknown bead "${beadId}"`);
    }

    visiting.add(beadId);
    for (const dependencyId of [...plan.dependencies].sort(compareStrings)) {
      visit(dependencyId);
    }
    visiting.delete(beadId);
    visited.add(beadId);
    ordered.push(plan);
  }

  for (const beadId of [...plansById.keys()].sort(compareStrings)) {
    visit(beadId);
  }
  return ordered;
}

function defaultTriggerComment(
  review: ReviewGate,
): Readonly<Record<string, string>> {
  return review === "greptile"
    ? { triggerComment: "@greptile review" }
    : review === "claude"
      ? { triggerComment: "@claude review" }
      : {};
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return normalized.length === 0 ? "bead" : normalized;
}

function validateOptions(
  targetBranch: string,
  review: ReviewGate,
  branchPrefix: string,
  reviewConfig: Omit<BeadsReviewConfig, "by"> | undefined,
  validationCommands: readonly string[] | undefined,
  maxIterations: number | undefined,
  includeMerge: boolean,
  mergeValidationCommands: readonly string[] | undefined,
  serializeMerges: boolean,
  includeBeadsUpdate: boolean,
  beadsRepo: string | undefined,
  finalPullRequest: FinalPullRequestOptions | undefined,
): void {
  if (typeof targetBranch !== "string" || targetBranch.trim().length === 0) {
    throw new Error("targetBranch must be a non-empty string");
  }
  if (review !== "greptile" && review !== "claude" && review !== "none") {
    throw new Error(`Unknown review gate: ${String(review)}`);
  }
  if (typeof branchPrefix !== "string") {
    throw new Error("branchPrefix must be a string");
  }
  validateReviewConfig(review, reviewConfig);
  validateCommands(validationCommands, "validationCommands");
  if (
    maxIterations !== undefined &&
    (!Number.isInteger(maxIterations) || maxIterations < 1)
  ) {
    throw new Error("maxIterations must be a positive integer");
  }
  if (typeof includeMerge !== "boolean") {
    throw new Error("includeMerge must be a boolean");
  }
  validateCommands(mergeValidationCommands, "mergeValidationCommands");
  if (typeof serializeMerges !== "boolean") {
    throw new Error("serializeMerges must be a boolean");
  }
  if (typeof includeBeadsUpdate !== "boolean") {
    throw new Error("includeBeadsUpdate must be a boolean");
  }
  if (beadsRepo !== undefined && typeof beadsRepo !== "string") {
    throw new Error("beadsRepo must be a string when provided");
  }
  if (finalPullRequest !== undefined) {
    if (!includeMerge) {
      throw new Error(
        "finalPullRequest requires includeMerge: without merge nodes no work lands on targetBranch",
      );
    }
    if (
      finalPullRequest.review !== "greptile" &&
      finalPullRequest.review !== "claude" &&
      finalPullRequest.review !== "none"
    ) {
      throw new Error("finalPullRequest.review is unknown");
    }
    if (
      typeof finalPullRequest.targetBranch !== "string" ||
      finalPullRequest.targetBranch.trim().length === 0
    ) {
      throw new Error("finalPullRequest.targetBranch must be non-empty");
    }
    // Trim before comparing: the finalize_pr executor compares trimmed
    // branches, and this guard must fire at generation time, not run time.
    if (finalPullRequest.targetBranch.trim() === targetBranch.trim()) {
      throw new Error(
        "finalPullRequest.targetBranch must differ from targetBranch",
      );
    }
    validateReviewConfig(
      finalPullRequest.review,
      finalPullRequest.reviewConfig,
    );
    validateCommands(
      finalPullRequest.validationCommands,
      "finalPullRequest.validationCommands",
    );
    if (
      finalPullRequest.maxIterations !== undefined &&
      (!Number.isInteger(finalPullRequest.maxIterations) ||
        finalPullRequest.maxIterations < 1)
    ) {
      throw new Error("finalPullRequest.maxIterations must be positive");
    }
    if (
      finalPullRequest.draft !== undefined &&
      typeof finalPullRequest.draft !== "boolean"
    ) {
      throw new Error("finalPullRequest.draft must be boolean");
    }
    for (const [field, value] of [
      ["title", finalPullRequest.title],
      ["body", finalPullRequest.body],
    ] as const) {
      if (value !== undefined && value.trim().length === 0) {
        throw new Error(`finalPullRequest.${field} must be non-empty`);
      }
    }
  }
}

function validateReviewConfig(
  review: ReviewGate,
  config: Omit<BeadsReviewConfig, "by"> | undefined,
): void {
  if (config === undefined) {
    return;
  }
  if (
    config.greptileAppSlug !== undefined &&
    (typeof config.greptileAppSlug !== "string" ||
      config.greptileAppSlug.trim().length === 0)
  ) {
    throw new Error("reviewConfig.greptileAppSlug must be a non-empty string");
  }
  if (config.greptileAppSlug !== undefined && review !== "greptile") {
    throw new Error(
      'reviewConfig.greptileAppSlug requires review to be "greptile"',
    );
  }
  if (
    config.minConfidenceScore !== undefined &&
    (!Number.isInteger(config.minConfidenceScore) ||
      config.minConfidenceScore < 1 ||
      config.minConfidenceScore > 5)
  ) {
    throw new Error("reviewConfig.minConfidenceScore must be from 1 to 5");
  }
  for (const [field, value] of [
    ["requireApproved", config.requireApproved],
    ["requireNoActionableFindings", config.requireNoActionableFindings],
    ["requireGreenChecks", config.requireGreenChecks],
    [
      "allowConfidenceFourWithoutActionableFindings",
      config.allowConfidenceFourWithoutActionableFindings,
    ],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`reviewConfig.${field} must be a boolean`);
    }
  }
  if (
    config.triggerComment !== undefined &&
    (typeof config.triggerComment !== "string" ||
      config.triggerComment.trim().length === 0)
  ) {
    throw new Error("reviewConfig.triggerComment must be a non-empty string");
  }
}

function validateCommands(
  commands: readonly string[] | undefined,
  field: string,
): void {
  if (commands === undefined) {
    return;
  }
  if (!Array.isArray(commands)) {
    throw new Error(`${field} must be an array`);
  }
  for (const [index, command] of commands.entries()) {
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error(`${field}[${String(index)}] must be a non-empty string`);
    }
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
