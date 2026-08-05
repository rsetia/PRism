import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  buildBeadsGraph,
  parseBeadsJsonl,
  type Bead,
  type BeadsGraphOptions,
  type GraphDefinition,
  type ReviewGate,
} from "@rsetia/prism";
import { createExecFileRunner, type CommandRunner } from "@rsetia/prism/node";
import { resolvePrismProjectPaths } from "./prism-home.js";

const DEFAULT_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "in_progress",
  "blocked",
]);
const SHOW_BATCH_SIZE = 50;

export interface GenerateBeadsDagOptions {
  readonly repoDir: string;
  readonly beadsRepoDir?: string;
  readonly outFile: string;
  readonly bdCommand?: string;
  readonly ids?: readonly string[];
  /** Undefined means the PRism-py default; null disables status filtering. */
  readonly statuses?: ReadonlySet<string> | null;
  readonly labels?: readonly string[];
  /**
   * Spec/RFC document whose full text is frozen into every context node as
   * `specDocument`, so workers receive the design contracts verbatim.
   */
  readonly specFile?: string;
  readonly targetBranch?: string;
  readonly branchPrefix?: string;
  readonly validationCommands?: readonly string[];
  readonly mergeValidationCommands?: readonly string[];
  readonly maxIterations?: number;
  readonly reviewer?: ReviewGate;
  readonly greptileAppSlug?: string;
  readonly minConfidenceScore?: number;
  readonly requireNoActionableFindings?: boolean;
  readonly requireGreenChecks?: boolean;
  readonly reviewTriggerComment?: string;
  readonly includeMerge?: boolean;
  readonly includeBeadsUpdate?: boolean;
  readonly serializeMerges?: boolean;
}

/**
 * Snapshot Beads through `bd`, hydrate the records used as Codex task input,
 * filter them, and write an ordinary Prism graph. Workers never need to read
 * the Beads database: all implementation context is frozen into graph nodes.
 */
export async function generateBeadsDag(
  options: GenerateBeadsDagOptions,
  runner: CommandRunner = createExecFileRunner(),
): Promise<GraphDefinition> {
  const projectPaths = resolvePrismProjectPaths(options.repoDir);
  const repoDir = projectPaths.repoDir;
  const beadsRepoDir = resolve(
    options.beadsRepoDir ?? projectPaths.beadsRepoDir ?? repoDir,
  );
  const bdCommand = options.bdCommand ?? "bd";
  // Read the spec before touching `bd`: an unreadable spec should fail fast
  // rather than after a full Beads export.
  let spec: { source: string; content: string } | undefined;
  if (options.specFile !== undefined) {
    const specPath = resolve(options.specFile);
    let content: string;
    try {
      content = await readFile(specPath, "utf8");
    } catch (error: unknown) {
      throw new Error(
        `cannot read spec file "${specPath}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (content.trim().length === 0) {
      throw new Error(`spec file "${specPath}" is empty`);
    }
    spec = { source: specPath, content };
  }
  const exported = await runner.run(
    bdCommand,
    ["export", "--no-memories", "--readonly"],
    { cwd: beadsRepoDir },
  );
  if (exported.exitCode !== 0) {
    throw new Error(
      commandError("bd export", exported.stderr, exported.stdout),
    );
  }

  const baseBeads = parseBeadsJsonl(exported.stdout);
  const requestedIds = unique(options.ids ?? []);
  assertRequestedIdsExist(baseBeads, requestedIds);
  const candidates =
    requestedIds.length === 0
      ? baseBeads
      : requestedIds.map((id) => {
          const found = baseBeads.find((bead) => bead.id === id);
          if (found === undefined) {
            throw new Error(`requested Beads id was not found: ${id}`);
          }
          return found;
        });
  const hydrated = await hydrateBeads(
    candidates,
    beadsRepoDir,
    bdCommand,
    runner,
  );
  const selected = selectBeads(hydrated, {
    statuses:
      options.statuses === undefined ? DEFAULT_STATUSES : options.statuses,
    labels: options.labels ?? [],
  });
  if (selected.length === 0) {
    throw new Error("no Beads issues matched the requested filters");
  }

  // Filtering is a boundary: dependencies outside the selected snapshot do
  // not become dangling graph edges. Their original records remain in the
  // bead metadata for context, while execution edges cover selected work.
  const selectedIds = new Set(selected.map((bead) => bead.id));
  const graphBeads = selected.map((bead) => ({
    ...bead,
    dependencies: (bead.dependencies ?? []).filter(
      (dependencyId) =>
        dependencyId !== bead.id && selectedIds.has(dependencyId),
    ),
  }));
  const reviewer = options.reviewer ?? "greptile";
  if (options.greptileAppSlug !== undefined && reviewer !== "greptile") {
    throw new Error('greptileAppSlug requires reviewer to be "greptile"');
  }
  const reviewTriggerComment =
    options.reviewTriggerComment ??
    (reviewer === "greptile"
      ? "@greptile review"
      : reviewer === "claude"
        ? "@claude review"
        : undefined);
  const graphOptions: BeadsGraphOptions = {
    ...(spec === undefined ? {} : { spec }),
    targetBranch: options.targetBranch ?? "main",
    branchPrefix: options.branchPrefix ?? "prism/",
    review: reviewer,
    reviewConfig: {
      ...(reviewer === "greptile"
        ? {
            minConfidenceScore: options.minConfidenceScore ?? 5,
            ...(options.greptileAppSlug === undefined
              ? {}
              : { greptileAppSlug: options.greptileAppSlug }),
          }
        : {}),
      requireNoActionableFindings: options.requireNoActionableFindings ?? true,
      requireGreenChecks: options.requireGreenChecks ?? true,
      ...(reviewTriggerComment === undefined
        ? {}
        : { triggerComment: reviewTriggerComment }),
    },
    validationCommands: options.validationCommands ?? [],
    ...(options.maxIterations === undefined
      ? {}
      : { maxIterations: options.maxIterations }),
    includeMerge: options.includeMerge ?? true,
    mergeValidationCommands: options.mergeValidationCommands ?? [],
    serializeMerges: options.serializeMerges ?? true,
    includeBeadsUpdate: options.includeBeadsUpdate ?? true,
    beadsRepo: beadsRepoDir,
  };
  const graph = buildBeadsGraph(graphBeads, graphOptions);
  await writeGraph(options.outFile, graph);
  return graph;
}

async function hydrateBeads(
  beads: readonly Bead[],
  cwd: string,
  bdCommand: string,
  runner: CommandRunner,
): Promise<readonly Bead[]> {
  const detailById = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < beads.length; index += SHOW_BATCH_SIZE) {
    const batch = beads.slice(index, index + SHOW_BATCH_SIZE);
    const shown = await runner.run(
      bdCommand,
      [
        "show",
        "--json",
        "--long",
        "--readonly",
        ...batch.map((bead) => bead.id),
      ],
      { cwd },
    );
    // Match PRism-py: hydration improves task context but an older `bd`
    // without these flags must not make graph generation impossible.
    if (shown.exitCode !== 0 || shown.stdout.trim().length === 0) {
      continue;
    }
    for (const detail of normalizeIssueCollection(shown.stdout)) {
      const id = issueId(detail);
      if (id !== undefined) {
        detailById.set(id, detail);
      }
    }
  }

  const mergedLines = beads.map((bead) => {
    const detail = detailById.get(bead.id);
    return JSON.stringify(
      detail === undefined ? bead : mergeNonEmpty(bead, detail),
    );
  });
  return parseBeadsJsonl(mergedLines.join("\n"));
}

function normalizeIssueCollection(
  source: string,
): readonly Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }
  if (!isRecord(parsed)) {
    return [];
  }
  for (const key of ["issues", "items", "results", "data"]) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }
  return issueId(parsed) === undefined ? [] : [parsed];
}

function mergeNonEmpty(
  base: Bead,
  detail: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(detail)) {
    // `bd show --long` expands reverse relationships into complete issues.
    // They are not prerequisites and multiply graph size without adding
    // implementation context. Keep forward dependencies and bead fields.
    if (key === "dependents" || key === "children") {
      continue;
    }
    if (!isEmpty(value)) {
      merged[key] = value;
    }
  }
  return merged;
}

function selectBeads(
  beads: readonly Bead[],
  filters: {
    readonly statuses: ReadonlySet<string> | null;
    readonly labels: readonly string[];
  },
): readonly Bead[] {
  const requiredLabels = new Set(filters.labels);
  return beads.filter((bead) => {
    if (
      filters.statuses !== null &&
      (typeof bead.status !== "string" ||
        !filters.statuses.has(bead.status.toLowerCase()))
    ) {
      return false;
    }
    const labels = new Set(beadLabels(bead));
    return [...requiredLabels].every((label) => labels.has(label));
  });
}

function beadLabels(bead: Bead): readonly string[] {
  const value = bead["labels"] ?? bead["tags"];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return entry;
    }
    if (!isRecord(entry)) {
      return [];
    }
    const label = entry["name"] ?? entry["label"];
    return typeof label === "string" ? [label] : [];
  });
}

function assertRequestedIdsExist(
  beads: readonly Bead[],
  requestedIds: readonly string[],
): void {
  const available = new Set(beads.map((bead) => bead.id));
  const missing = requestedIds.filter((id) => !available.has(id));
  if (missing.length > 0) {
    throw new Error(
      `requested Beads ids were not found: ${missing.join(", ")}`,
    );
  }
}

async function writeGraph(
  outFile: string,
  graph: GraphDefinition,
): Promise<void> {
  const path = resolve(outFile);
  const extension = extname(path).toLowerCase();
  const contents =
    extension === ".yaml" || extension === ".yml"
      ? stringifyYaml(graph, { lineWidth: 100 })
      : `${JSON.stringify(graph, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

function unique(values: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const item of value.split(",")) {
      const normalized = item.trim();
      if (normalized.length > 0 && !seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }
  }
  return result;
}

function issueId(value: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["id", "issue_id", "bead_id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0)
  );
}

function commandError(command: string, stderr: string, stdout: string): string {
  const detail = stderr.trim() || stdout.trim();
  return detail.length === 0
    ? `${command} failed`
    : `${command} failed: ${detail}`;
}
