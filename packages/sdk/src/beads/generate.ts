import type { GraphDefinition } from "../graph/types.js";
import { isPlainObject } from "../internal/json.js";

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

export interface BeadsGraphOptions {
  /** Branch PRs target. Default "main". */
  readonly targetBranch?: string;
  /** Review gate for every implement node. Default "none". */
  readonly review?: ReviewGate;
  /** Prefix for generated feature branch names. Default "agent-graph/". */
  readonly branchPrefix?: string;
  /** Add a merge_resolve node after each implement. Default true. */
  readonly includeMerge?: boolean;
  /** Add a beads_update node after each merge. Default true. */
  readonly includeBeadsUpdate?: boolean;
  /** Passed to beads_update nodes so they know where to run `bd`. */
  readonly beadsRepo?: string;
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

    const dependencies = normalizeDependencies(parsed["dependencies"]);
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
  const review = options?.review ?? "none";
  const branchPrefix = options?.branchPrefix ?? "agent-graph/";
  const includeMerge = options?.includeMerge ?? true;
  const includeBeadsUpdate = options?.includeBeadsUpdate ?? true;
  validateOptions(
    targetBranch,
    review,
    branchPrefix,
    includeMerge,
    includeBeadsUpdate,
    options?.beadsRepo,
  );

  interface BeadPlan {
    readonly bead: Bead;
    readonly slug: string;
    readonly dependencies: readonly string[];
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

  for (const plan of orderedPlans) {
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
      dependsOn: dependencyNodes,
      config: {
        workItem,
        targetBranch,
        branchName: `${branchPrefix}${plan.slug}`,
        review: { by: review },
      },
    };

    let terminalNodeId = plan.implementNodeId;
    if (includeMerge) {
      nodes[plan.mergeNodeId] = {
        executor: "merge_resolve",
        kind: "task",
        dependsOn: [plan.implementNodeId],
        config: {
          targetBranch,
          sourceBranchFrom: plan.implementNodeId,
          mergeMethod: "squash",
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
    terminalNodeIds.push(terminalNodeId);
  }

  if (terminalNodeIds.length === 1) {
    const finalNode = terminalNodeIds[0];
    if (finalNode === undefined) {
      throw new Error("Beads graph lost its final node");
    }
    return { version: 1, nodes, finalNode };
  }

  const finalNode = "beads-final";
  nodes[finalNode] = {
    executor: "join_newline",
    kind: "merge",
    dependsOn: terminalNodeIds,
  };
  return { version: 1, nodes, finalNode };
}

const DEPENDENCY_ID_PROPERTIES = [
  "id",
  "issue_id",
  "issueId",
  "bead_id",
  "beadId",
  "dependency_id",
  "dependencyId",
  "depends_on_id",
  "dependsOnId",
  "blocker_id",
  "blockerId",
  "source_id",
  "sourceId",
] as const;

function normalizeDependencies(value: unknown): string[] {
  const entries =
    value === undefined || value === null
      ? []
      : Array.isArray(value)
        ? value
        : [value];
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

function dependencyIdFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id.length === 0 ? undefined : id;
  }
  if (!isPlainObject(value)) {
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
  includeMerge: boolean,
  includeBeadsUpdate: boolean,
  beadsRepo: string | undefined,
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
  if (typeof includeMerge !== "boolean") {
    throw new Error("includeMerge must be a boolean");
  }
  if (typeof includeBeadsUpdate !== "boolean") {
    throw new Error("includeBeadsUpdate must be a boolean");
  }
  if (beadsRepo !== undefined && typeof beadsRepo !== "string") {
    throw new Error("beadsRepo must be a string when provided");
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
