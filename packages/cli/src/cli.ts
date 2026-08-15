/**
 * The whole CLI, isolated from process wiring so exit codes and output
 * are testable. Only `main.ts` touches `process`.
 *
 * A CLI is an API (plan §6): stdout carries machine-readable data and
 * NOTHING else — it gets piped. Every human-facing diagnostic goes to
 * stderr. Exit codes are the interface for shell scripts.
 */
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  abortRun,
  compileGraph,
  createEngine,
  createMemoryStore,
  createSystemClock,
  inspectRun,
  parseGraph,
  resetRun,
  watchRun,
} from "@rsetia/prism";
import type {
  CompiledGraph,
  GraphCompileError,
  GraphParseError,
  NodeFailure,
  PhaseDuration,
  PersistedRunEvent,
  LogBackend,
  RunInspection,
  RunOutcome,
  RunStore,
} from "@rsetia/prism";
import { createFileLogBackend, createSqliteStore } from "@rsetia/prism/node";
import {
  createAgentExecutorRegistry,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
} from "./agent-executors.js";
import { generateBeadsDag } from "./beads-dag.js";
import { applyGreptileAppSlug } from "./review-policy.js";
import {
  missingPrismHomeMessage,
  resolvePrismProjectPaths,
} from "./prism-home.js";
import {
  SKILL_AGENTS,
  installSkills,
  listBundledSkills,
  resolveSkillsInstallDir,
} from "./skills.js";
import type { SkillAgent, SkillScope } from "./skills.js";
import { renderWatchDashboard } from "./watch-renderer.js";

/** Non-TTY stdout is data; interactive watch may redraw a human dashboard. */
export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly write?: (text: string) => void;
  readonly interactive?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly color?: boolean;
}

export const EXIT_SUCCESS = 0;
/** The graph ran and failed — a normal, expected outcome. */
export const EXIT_RUN_FAILED = 1;
/** Invalid input or usage — the caller's mistake. */
export const EXIT_USAGE = 2;
/** Unexpected internal error — our bug. Assigned by main.ts. */
export const EXIT_INTERNAL = 3;
export const DEFAULT_MAX_CONCURRENCY = 4;

export const USAGE = `Usage: prism <command> [options]

Plan first:
  Prism bundles an agent skill, "prism-plan-project", that turns a product or
  engineering discussion into a Beads backlog and an executable Prism DAG.
  Install it once so your agent discovers it on its own:

    prism skills install

  Then ask your agent to plan the project in plain language. The skill decides
  what can run in parallel and calls "beads-dag", which is a compiler, not a
  planner — reach for it directly only when the work items already exist.

Commands:
  skills list [--json]                Show the agent skills bundled with Prism
  skills install [<name>...] [--agent claude|codex] [--project] [--repo <path>]
                 [--force] [--json]
                                      Install them into the agent's skills directory
  validate <file>                     Check a graph file; exit 0 if valid
  graph <file> [--json]               Print the compiled plan
  beads-dag --out <file> [--repo <path>] [--beads-repo <path>]
            [--greptile-app-slug <slug>] [--spec-file <path>]
            [--final-pr-base <branch>] [--final-pr-reviewer claude|greptile|none]
            [--final-pr-validation-command <command>] [--final-pr-draft]
                                      Snapshot Beads into an agent DAG
  run <file> [--json] [--store <db>] [--run-id <id>] [--repo <path>]
             [--max-concurrency <n>] [--codex-bin <path>] [--codex-model <id>]
             [--codex-reasoning-effort <level>]
             [--greptile-app-slug <slug>]
                                      Execute the graph
  inspect <run-id> [--store <db>] [--json]
                                      Show a persisted run's node states
  events <run-id> [--store <db>] [--json]
                                      Show a persisted run's event log
  logs [<run-id>] [--store <db>] [--json] [--repo <path>]
                                      Follow worker output (default latest run)
  status [--store <db>] [--json]      List persisted runs
  watch [<run-id>] [--store <db>] [--json] [--interval <ms>] [--repo <path>]
                                      Render the live DAG (default latest running run)
  resume <run-id> [--store <db>] [--json] [--repo <path>]
         [--max-concurrency <n>] [--codex-bin <path>] [--codex-model <id>]
         [--codex-reasoning-effort <level>]
                                      Continue an interrupted run to completion
  abort <run-id> [--store <db>] [--json]
                                      Force a stuck run to a cancelled, finished state
  signal <run-id> <node-id> [--store <db>] [--json]
                                      Reset a node so a later resume re-runs it
  rerun-node <run-id> <node-id> [--store <db>] [--json]
                                      Reset a node and its downstream, then resume

Defaults:
  Repository                            Current git repository
  Beads, store, worktrees, and logs     $PRISM_HOME/<kind>/<project>/...
  Skill install target                  ~/.claude/skills
  Pull-request reviewer                 Greptile (@greptile review)
  Maximum concurrency                   ${String(DEFAULT_MAX_CONCURRENCY)}
  Codex model                           ${DEFAULT_CODEX_MODEL}
  Codex reasoning effort                ${DEFAULT_CODEX_REASONING_EFFORT}`;

interface ValidateInvocation {
  readonly command: "validate";
  readonly file: string;
}
interface GraphInvocation {
  readonly command: "graph";
  readonly file: string;
  readonly json: boolean;
}
interface RunInvocation {
  readonly command: "run";
  readonly file: string;
  readonly json: boolean;
  readonly store: string | undefined;
  readonly runId: string | undefined;
  readonly greptileAppSlug: string | undefined;
  readonly agent: AgentInvocationOptions;
}
interface BeadsDagInvocation {
  readonly command: "beads-dag";
  readonly repo: string | undefined;
  readonly beadsRepo: string | undefined;
  readonly out: string;
  readonly bdCommand: string;
  readonly specFile: string | undefined;
  readonly ids: readonly string[];
  readonly statuses: ReadonlySet<string> | null;
  readonly labels: readonly string[];
  readonly targetBranch: string;
  readonly branchPrefix: string;
  readonly validationCommands: readonly string[];
  readonly mergeValidationCommands: readonly string[];
  readonly maxIterations: number;
  readonly reviewer: "greptile" | "claude" | "none";
  readonly greptileAppSlug: string | undefined;
  readonly minConfidenceScore: number;
  readonly requireNoActionableFindings: boolean;
  readonly requireGreenChecks: boolean;
  readonly reviewTriggerComment: string | undefined;
  readonly includeMerge: boolean;
  readonly includeBeadsUpdate: boolean;
  readonly serializeMerges: boolean;
  readonly finalPrBase: string | undefined;
  readonly finalPrReviewer: "greptile" | "claude" | "none";
  readonly finalPrReviewTriggerComment: string | undefined;
  readonly finalPrValidationCommands: readonly string[];
  readonly finalPrMaxIterations: number;
  readonly finalPrDraft: boolean;
}
interface ReadInvocation {
  readonly command: "inspect" | "events";
  readonly runId: string;
  readonly json: boolean;
  readonly store: string | undefined;
}
interface LogsInvocation {
  readonly command: "logs";
  readonly runId: string | undefined;
  readonly json: boolean;
  readonly store: string | undefined;
  readonly repo: string | undefined;
}
interface StatusInvocation {
  readonly command: "status";
  readonly json: boolean;
  readonly store: string | undefined;
}
interface WatchInvocation {
  readonly command: "watch";
  readonly runId: string | undefined;
  readonly json: boolean;
  readonly store: string | undefined;
  readonly repo: string | undefined;
  readonly intervalMs: number;
}
interface ResumeInvocation {
  readonly command: "resume";
  readonly runId: string;
  readonly json: boolean;
  readonly store: string | undefined;
  readonly agent: AgentInvocationOptions;
}
interface AbortInvocation {
  readonly command: "abort";
  readonly runId: string;
  readonly json: boolean;
  readonly store: string | undefined;
}
interface NodeTargetInvocation {
  readonly command: "signal" | "rerun-node";
  readonly runId: string;
  readonly nodeId: string;
  readonly json: boolean;
  readonly store: string | undefined;
}
interface SkillsInvocation {
  readonly command: "skills";
  readonly action: "list" | "install";
  readonly names: readonly string[];
  readonly agent: SkillAgent;
  readonly scope: SkillScope;
  readonly repo: string | undefined;
  readonly force: boolean;
  readonly json: boolean;
}
interface HelpInvocation {
  readonly command: "help";
}
type Invocation =
  | ValidateInvocation
  | GraphInvocation
  | BeadsDagInvocation
  | RunInvocation
  | ReadInvocation
  | LogsInvocation
  | StatusInvocation
  | WatchInvocation
  | ResumeInvocation
  | AbortInvocation
  | NodeTargetInvocation
  | SkillsInvocation
  | HelpInvocation;

interface AgentInvocationOptions {
  readonly repo: string | undefined;
  readonly maxConcurrency: number;
  readonly codexCommand: string | undefined;
  readonly codexModel: string | undefined;
  readonly codexReasoningEffort: string | undefined;
  readonly worktreeDir: string | undefined;
}

interface ParsedFlags {
  readonly positionals: readonly string[];
  readonly json: boolean;
  readonly store: string | undefined;
  readonly runId: string | undefined;
  readonly interval: string | undefined;
  readonly repo: string | undefined;
  readonly maxConcurrency: string | undefined;
  readonly codexCommand: string | undefined;
  readonly codexModel: string | undefined;
  readonly codexReasoningEffort: string | undefined;
  readonly worktreeDir: string | undefined;
  readonly greptileAppSlug: string | undefined;
}

/** Positional args plus known scalar flags; an unknown flag is invalid. */
function parseFlags(rest: readonly string[]): ParsedFlags | undefined {
  const positionals: string[] = [];
  let json = false;
  let store: string | undefined;
  let runId: string | undefined;
  let interval: string | undefined;
  let repo: string | undefined;
  let maxConcurrency: string | undefined;
  let codexCommand: string | undefined;
  let codexModel: string | undefined;
  let codexReasoningEffort: string | undefined;
  let worktreeDir: string | undefined;
  let greptileAppSlug: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      if (json) return undefined;
      json = true;
    } else if (
      arg === "--store" ||
      arg === "--run-id" ||
      arg === "--interval" ||
      arg === "--repo" ||
      arg === "--max-concurrency" ||
      arg === "--codex-bin" ||
      arg === "--codex-model" ||
      arg === "--codex-reasoning-effort" ||
      arg === "--worktree-dir" ||
      arg === "--greptile-app-slug"
    ) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      index += 1;
      if (arg === "--store") {
        if (store !== undefined) return undefined;
        store = value;
      } else if (arg === "--run-id") {
        if (runId !== undefined) return undefined;
        runId = value;
      } else if (arg === "--interval") {
        if (interval !== undefined) return undefined;
        interval = value;
      } else if (arg === "--repo") {
        if (repo !== undefined) return undefined;
        repo = value;
      } else if (arg === "--max-concurrency") {
        if (maxConcurrency !== undefined) return undefined;
        maxConcurrency = value;
      } else if (arg === "--codex-bin") {
        if (codexCommand !== undefined) return undefined;
        codexCommand = value;
      } else if (arg === "--codex-model") {
        if (codexModel !== undefined) return undefined;
        codexModel = value;
      } else if (arg === "--codex-reasoning-effort") {
        if (codexReasoningEffort !== undefined) return undefined;
        codexReasoningEffort = value;
      } else if (arg === "--worktree-dir") {
        if (worktreeDir !== undefined) return undefined;
        worktreeDir = value;
      } else {
        if (greptileAppSlug !== undefined || value.trim().length === 0) {
          return undefined;
        }
        greptileAppSlug = value.trim();
      }
    } else if (arg?.startsWith("--") === true) {
      return undefined;
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }

  return {
    positionals,
    json,
    store,
    runId,
    interval,
    repo,
    maxConcurrency,
    codexCommand,
    codexModel,
    codexReasoningEffort,
    worktreeDir,
    greptileAppSlug,
  };
}

function parseInvocation(argv: readonly string[]): Invocation | undefined {
  const [command, ...rest] = argv;
  if (command === "beads-dag") {
    return parseBeadsDagInvocation(rest);
  }
  if (command === "skills") {
    return parseSkillsInvocation(rest);
  }
  if (
    rest.length === 0 &&
    (command === "help" || command === "--help" || command === "-h")
  ) {
    return { command: "help" };
  }
  const flags = parseFlags(rest);
  if (flags === undefined) return undefined;

  const [first, second] = flags.positionals;
  const count = flags.positionals.length;
  const noExtras =
    flags.store === undefined &&
    flags.runId === undefined &&
    flags.interval === undefined &&
    noAgentFlags(flags);

  switch (command) {
    case "validate":
      if (count !== 1 || first === undefined || flags.json || !noExtras) {
        return undefined;
      }
      return { command, file: first };
    case "graph":
      if (
        count !== 1 ||
        first === undefined ||
        flags.store !== undefined ||
        flags.runId !== undefined ||
        flags.interval !== undefined ||
        !noAgentFlags(flags)
      ) {
        return undefined;
      }
      return { command, file: first, json: flags.json };
    case "run":
      if (count !== 1 || first === undefined || flags.interval !== undefined) {
        return undefined;
      }
      {
        const agent = parseAgentOptions(flags);
        if (agent === undefined) return undefined;
        return {
          command,
          file: first,
          json: flags.json,
          store: flags.store,
          runId: flags.runId,
          greptileAppSlug: flags.greptileAppSlug,
          agent,
        };
      }
    case "inspect":
    case "events":
      if (
        count !== 1 ||
        first === undefined ||
        flags.runId !== undefined ||
        flags.interval !== undefined ||
        !noAgentFlags(flags)
      ) {
        return undefined;
      }
      return {
        command,
        runId: first,
        json: flags.json,
        store: flags.store,
      };
    case "logs":
      if (
        count > 1 ||
        (first !== undefined && flags.runId !== undefined) ||
        flags.interval !== undefined ||
        !noWorkerFlags(flags)
      ) {
        return undefined;
      }
      return {
        command,
        runId: first ?? flags.runId,
        json: flags.json,
        store: flags.store,
        repo: flags.repo,
      };
    case "resume": {
      if (
        count !== 1 ||
        first === undefined ||
        flags.runId !== undefined ||
        flags.interval !== undefined ||
        flags.greptileAppSlug !== undefined
      ) {
        return undefined;
      }
      const agent = parseAgentOptions(flags);
      if (agent === undefined) return undefined;
      return {
        command,
        runId: first,
        json: flags.json,
        store: flags.store,
        agent,
      };
    }
    case "abort":
      if (
        count !== 1 ||
        first === undefined ||
        flags.runId !== undefined ||
        flags.interval !== undefined ||
        !noAgentFlags(flags)
      ) {
        return undefined;
      }
      return { command, runId: first, json: flags.json, store: flags.store };
    case "signal":
    case "rerun-node":
      if (
        count !== 2 ||
        first === undefined ||
        second === undefined ||
        flags.runId !== undefined ||
        flags.interval !== undefined ||
        !noAgentFlags(flags)
      ) {
        return undefined;
      }
      return {
        command,
        runId: first,
        nodeId: second,
        json: flags.json,
        store: flags.store,
      };
    case "status":
      if (
        count !== 0 ||
        flags.runId !== undefined ||
        flags.interval !== undefined ||
        !noAgentFlags(flags)
      ) {
        return undefined;
      }
      return { command, json: flags.json, store: flags.store };
    case "watch": {
      if (
        count > 1 ||
        (first !== undefined && flags.runId !== undefined) ||
        !noWorkerFlags(flags)
      ) {
        return undefined;
      }
      const intervalMs =
        flags.interval === undefined ? 1_000 : Number(flags.interval);
      if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
        return undefined;
      }
      return {
        command,
        runId: first ?? flags.runId,
        json: flags.json,
        store: flags.store,
        repo: flags.repo,
        intervalMs,
      };
    }
    default:
      return undefined;
  }
}

function noAgentFlags(flags: ParsedFlags): boolean {
  return (
    flags.repo === undefined &&
    flags.maxConcurrency === undefined &&
    flags.codexCommand === undefined &&
    flags.codexModel === undefined &&
    flags.codexReasoningEffort === undefined &&
    flags.worktreeDir === undefined &&
    flags.greptileAppSlug === undefined
  );
}

function noWorkerFlags(flags: ParsedFlags): boolean {
  return (
    flags.maxConcurrency === undefined &&
    flags.codexCommand === undefined &&
    flags.codexModel === undefined &&
    flags.codexReasoningEffort === undefined &&
    flags.worktreeDir === undefined &&
    flags.greptileAppSlug === undefined
  );
}

function parseAgentOptions(
  flags: ParsedFlags,
): AgentInvocationOptions | undefined {
  const maxConcurrency =
    flags.maxConcurrency === undefined
      ? DEFAULT_MAX_CONCURRENCY
      : Number(flags.maxConcurrency);
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    return undefined;
  }
  return {
    repo: flags.repo,
    maxConcurrency,
    codexCommand: flags.codexCommand,
    codexModel: flags.codexModel,
    codexReasoningEffort: flags.codexReasoningEffort,
    worktreeDir: flags.worktreeDir,
  };
}

/** `skills` takes flags the shared parser does not know, so it parses its own. */
function parseSkillsInvocation(
  args: readonly string[],
): SkillsInvocation | undefined {
  const [action, ...rest] = args;
  if (action !== "list" && action !== "install") return undefined;

  const names: string[] = [];
  let agent: SkillAgent | undefined;
  let repo: string | undefined;
  let scope: SkillScope | undefined;
  let force = false;
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) return undefined;
    if (arg === "--agent" || arg === "--repo") {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      index += 1;
      if (arg === "--repo") {
        if (repo !== undefined) return undefined;
        repo = value;
      } else {
        if (agent !== undefined) return undefined;
        if (!SKILL_AGENTS.includes(value as SkillAgent)) return undefined;
        agent = value as SkillAgent;
      }
      continue;
    }
    if (arg === "--project" || arg === "--user") {
      const requested: SkillScope = arg === "--project" ? "project" : "user";
      if (scope !== undefined) return undefined;
      scope = requested;
      continue;
    }
    if (arg === "--force") {
      if (force) return undefined;
      force = true;
      continue;
    }
    if (arg === "--json") {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (arg.startsWith("--")) return undefined;
    names.push(arg);
  }

  // `list` reports what ships; install targets are meaningless there.
  if (
    action === "list" &&
    (names.length > 0 ||
      force ||
      agent !== undefined ||
      scope !== undefined ||
      repo !== undefined)
  ) {
    return undefined;
  }

  return {
    command: "skills",
    action,
    names,
    agent: agent ?? "claude",
    scope: scope ?? "user",
    repo,
    force,
    json,
  };
}

function parseBeadsDagInvocation(
  args: readonly string[],
): BeadsDagInvocation | undefined {
  const scalar = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const switches = new Set<string>();
  const scalarFlags = new Set([
    "--repo",
    "--beads-repo",
    "--out",
    "--bd-bin",
    "--spec-file",
    "--target-branch",
    "--branch-prefix",
    "--max-iterations",
    "--reviewer",
    "--greptile-app-slug",
    "--min-confidence-score",
    "--review-trigger-comment",
    "--greptile-trigger-comment",
    "--final-pr-base",
    "--final-pr-reviewer",
    "--final-pr-review-trigger-comment",
    "--final-pr-max-iterations",
  ]);
  const repeatedFlags = new Set([
    "--id",
    "--status",
    "--label",
    "--validation-command",
    "--merge-validation-command",
    "--final-pr-validation-command",
  ]);
  const switchFlags = new Set([
    "--all-statuses",
    "--allow-actionable-findings",
    "--skip-green-checks",
    "--no-merge-nodes",
    "--no-beads-update",
    "--no-serialize-merges",
    "--final-pr-draft",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) return undefined;
    if (scalarFlags.has(arg) || repeatedFlags.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      index += 1;
      if (scalarFlags.has(arg)) {
        if (scalar.has(arg)) return undefined;
        scalar.set(arg, value);
      } else {
        const values = repeated.get(arg) ?? [];
        values.push(value);
        repeated.set(arg, values);
      }
      continue;
    }
    if (switchFlags.has(arg)) {
      if (switches.has(arg)) return undefined;
      switches.add(arg);
      continue;
    }
    return undefined;
  }

  const out = scalar.get("--out");
  if (out === undefined) {
    return undefined;
  }
  const reviewer = scalar.get("--reviewer") ?? "greptile";
  if (reviewer !== "greptile" && reviewer !== "claude" && reviewer !== "none") {
    return undefined;
  }
  const finalPrReviewer = scalar.get("--final-pr-reviewer") ?? reviewer;
  if (
    finalPrReviewer !== "greptile" &&
    finalPrReviewer !== "claude" &&
    finalPrReviewer !== "none"
  ) {
    return undefined;
  }
  const greptileAppSlug = scalar.get("--greptile-app-slug")?.trim();
  if (
    (greptileAppSlug !== undefined && greptileAppSlug.length === 0) ||
    (greptileAppSlug !== undefined &&
      reviewer !== "greptile" &&
      finalPrReviewer !== "greptile")
  ) {
    return undefined;
  }
  const maxIterations = Number(scalar.get("--max-iterations") ?? "8");
  const minConfidenceScore = Number(
    scalar.get("--min-confidence-score") ?? "5",
  );
  const finalPrMaxIterations = Number(
    scalar.get("--final-pr-max-iterations") ?? String(maxIterations),
  );
  if (
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 1 ||
    !Number.isSafeInteger(minConfidenceScore) ||
    minConfidenceScore < 1 ||
    minConfidenceScore > 5 ||
    !Number.isSafeInteger(finalPrMaxIterations) ||
    finalPrMaxIterations < 1
  ) {
    return undefined;
  }
  const allStatuses = switches.has("--all-statuses");
  if (allStatuses && repeated.has("--status")) {
    return undefined;
  }
  const statuses = allStatuses
    ? null
    : new Set(
        csvValues(repeated.get("--status") ?? ["open,in_progress,blocked"]).map(
          (status) => status.toLowerCase(),
        ),
      );
  if (statuses !== null && statuses.size === 0) {
    return undefined;
  }
  const finalPrBase = scalar.get("--final-pr-base");
  const hasFinalPrOptions =
    scalar.has("--final-pr-reviewer") ||
    scalar.has("--final-pr-review-trigger-comment") ||
    scalar.has("--final-pr-max-iterations") ||
    repeated.has("--final-pr-validation-command") ||
    switches.has("--final-pr-draft");
  if (finalPrBase === undefined && hasFinalPrOptions) {
    return undefined;
  }

  return {
    command: "beads-dag",
    repo: scalar.get("--repo"),
    beadsRepo: scalar.get("--beads-repo"),
    out,
    bdCommand: scalar.get("--bd-bin") ?? "bd",
    specFile: scalar.get("--spec-file"),
    ids: csvValues(repeated.get("--id") ?? []),
    statuses,
    labels: csvValues(repeated.get("--label") ?? []),
    targetBranch: scalar.get("--target-branch") ?? "main",
    branchPrefix: scalar.get("--branch-prefix") ?? "prism/",
    validationCommands: repeated.get("--validation-command") ?? [],
    mergeValidationCommands: repeated.get("--merge-validation-command") ?? [],
    maxIterations,
    reviewer,
    greptileAppSlug,
    minConfidenceScore,
    requireNoActionableFindings: !switches.has("--allow-actionable-findings"),
    requireGreenChecks: !switches.has("--skip-green-checks"),
    reviewTriggerComment:
      scalar.get("--review-trigger-comment") ??
      scalar.get("--greptile-trigger-comment"),
    includeMerge: !switches.has("--no-merge-nodes"),
    includeBeadsUpdate: !switches.has("--no-beads-update"),
    serializeMerges: !switches.has("--no-serialize-merges"),
    finalPrBase,
    finalPrReviewer,
    finalPrReviewTriggerComment: scalar.get(
      "--final-pr-review-trigger-comment",
    ),
    finalPrValidationCommands:
      repeated.get("--final-pr-validation-command") ?? [],
    finalPrMaxIterations,
    finalPrDraft: switches.has("--final-pr-draft"),
  };
}

function csvValues(values: readonly string[]): string[] {
  return values.flatMap((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function describeError(error: unknown): string {
  const description = error instanceof Error ? error.message : String(error);
  return description.replace(/\s+/g, " ").trim();
}

async function openPersistentStore(
  explicitPath: string | undefined,
  repoDir?: string,
): Promise<RunStore> {
  const projectPaths = resolvePrismProjectPaths(repoDir);
  const path =
    explicitPath === undefined ? projectPaths.storePath : resolve(explicitPath);
  if (path === undefined) {
    throw new Error(missingPrismHomeMessage("--store <db>"));
  }
  await mkdir(dirname(path), { recursive: true });
  return createSqliteStore({ path });
}

function reportGraphErrors(
  errors: readonly (GraphParseError | GraphCompileError)[],
  io: CliIo,
): void {
  for (const error of errors) {
    const details = Object.fromEntries(
      Object.entries(error).filter(([key]) => key !== "code"),
    );
    io.stderr(`error ${error.code} ${JSON.stringify(details)}`);
  }
}

function getCompiledNode(
  graph: CompiledGraph,
  nodeId: string,
): CompiledGraph["nodes"][string] {
  const node = graph.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`compiled graph is missing node "${nodeId}"`);
  }
  return node;
}

function stringifyJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("value cannot be represented as JSON");
  }
  return encoded;
}

function printTextGraph(graph: CompiledGraph, io: CliIo): void {
  for (const nodeId of graph.order) {
    const node = getCompiledNode(graph, nodeId);
    const dependencies =
      node.dependsOn.length === 0 ? "" : ` <- ${node.dependsOn.join(", ")}`;
    io.stdout(`${node.id} (${node.executor})${dependencies}`);
  }
  io.stdout(`final: ${graph.finalNode}`);
}

function printJsonGraph(graph: CompiledGraph, io: CliIo): void {
  const nodes: Record<
    string,
    {
      readonly executor: string;
      readonly kind: CompiledGraph["nodes"][string]["kind"];
      readonly dependsOn: readonly string[];
      readonly dependents: readonly string[];
    }
  > = Object.create(null) as Record<
    string,
    {
      readonly executor: string;
      readonly kind: CompiledGraph["nodes"][string]["kind"];
      readonly dependsOn: readonly string[];
      readonly dependents: readonly string[];
    }
  >;

  for (const nodeId of graph.order) {
    const node = getCompiledNode(graph, nodeId);
    nodes[nodeId] = {
      executor: node.executor,
      kind: node.kind,
      dependsOn: node.dependsOn,
      dependents: node.dependents,
    };
  }

  io.stdout(
    stringifyJson({
      version: 1,
      order: graph.order,
      finalNode: graph.finalNode,
      nodes,
    }),
  );
}

function reportRunFailures(failures: readonly NodeFailure[], io: CliIo): void {
  for (const failure of failures) {
    io.stderr(
      `node "${failure.nodeId}" failed: ${stringifyJson(failure.cause)}`,
    );
  }
}

/** Render a terminal run outcome; shared by `run` and `resume`. */
function reportOutcome(outcome: RunOutcome, json: boolean, io: CliIo): number {
  switch (outcome.status) {
    case "succeeded":
      io.stdout(
        json
          ? stringifyJson({
              version: 1,
              status: outcome.status,
              output: outcome.output,
            })
          : stringifyJson(outcome.output),
      );
      return EXIT_SUCCESS;
    case "failed":
      if (json) {
        io.stdout(
          stringifyJson({
            version: 1,
            status: outcome.status,
            failures: outcome.failures,
          }),
        );
      } else {
        reportRunFailures(outcome.failures, io);
      }
      return EXIT_RUN_FAILED;
    case "cancelled":
      if (json) {
        io.stdout(
          stringifyJson({
            version: 1,
            status: outcome.status,
            reason: outcome.reason,
            failures: outcome.failures,
          }),
        );
      } else {
        io.stderr(`run cancelled: ${stringifyJson(outcome.reason)}`);
        reportRunFailures(outcome.failures, io);
      }
      return EXIT_RUN_FAILED;
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled outcome: ${JSON.stringify(unhandled)}`);
    }
  }
}

async function loadGraph(
  file: string,
  io: CliIo,
): Promise<CompiledGraph | undefined> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error: unknown) {
    io.stderr(`cannot read "${file}": ${describeError(error)}`);
    return undefined;
  }

  let input: unknown;
  const extension = extname(file).toLowerCase();
  const format =
    extension === ".yaml" || extension === ".yml" ? "YAML" : "JSON";
  try {
    input =
      format === "YAML" ? parseYaml(source) : (JSON.parse(source) as unknown);
  } catch (error: unknown) {
    io.stderr(`invalid ${format} in "${file}": ${describeError(error)}`);
    return undefined;
  }

  const parsed = parseGraph(input);
  if (!parsed.ok) {
    reportGraphErrors(parsed.errors, io);
    return undefined;
  }

  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) {
    reportGraphErrors(compiled.errors, io);
    return undefined;
  }
  return compiled.graph;
}

async function runGraph(
  graph: CompiledGraph,
  invocation: RunInvocation,
  io: CliIo,
): Promise<number> {
  const json = invocation.json;
  let effectiveGraph = graph;
  if (invocation.greptileAppSlug !== undefined) {
    try {
      effectiveGraph = applyGreptileAppSlug(
        graph,
        invocation.greptileAppSlug,
      ).graph;
    } catch (error: unknown) {
      io.stderr(`cannot apply Greptile app override: ${describeError(error)}`);
      return EXIT_USAGE;
    }
  }
  let hasDefaultStore: boolean;
  try {
    const projectPaths = resolvePrismProjectPaths(invocation.agent.repo);
    if (projectPaths.prismHome === undefined) {
      throw new Error(executionPrismHomeMessage());
    }
    hasDefaultStore = projectPaths.storePath !== undefined;
  } catch (error: unknown) {
    io.stderr(`cannot resolve project paths: ${describeError(error)}`);
    return EXIT_USAGE;
  }
  const durable =
    invocation.store !== undefined ||
    invocation.runId !== undefined ||
    hasDefaultStore;
  let store: RunStore;
  try {
    store = durable
      ? await openPersistentStore(invocation.store, invocation.agent.repo)
      : createMemoryStore();
  } catch (error: unknown) {
    io.stderr(`cannot open run store: ${describeError(error)}`);
    return EXIT_USAGE;
  }
  let outcome: RunOutcome;
  try {
    const engine = createEngine({
      store,
      registry: createAgentExecutorRegistry({
        ...(invocation.agent.repo === undefined
          ? {}
          : { repoDir: invocation.agent.repo }),
        ...(invocation.agent.worktreeDir === undefined
          ? {}
          : { worktreeBaseDir: invocation.agent.worktreeDir }),
        ...(invocation.agent.codexCommand === undefined
          ? {}
          : { codexCommand: invocation.agent.codexCommand }),
        ...(invocation.agent.codexModel === undefined
          ? {}
          : { codexModel: invocation.agent.codexModel }),
        ...(invocation.agent.codexReasoningEffort === undefined
          ? {}
          : {
              codexReasoningEffort: invocation.agent.codexReasoningEffort,
            }),
      }),
      maxConcurrency: invocation.agent.maxConcurrency,
    });
    const runId =
      invocation.runId ?? (durable ? `run-${randomUUID()}` : undefined);
    const handle = engine.run(
      effectiveGraph,
      runId === undefined ? {} : { runId },
    );
    // The run id is a human diagnostic (stderr) so `inspect`/`events` can
    // target it; stdout stays pure data.
    io.stderr(`run ${handle.id}`);
    try {
      outcome = await handle.result;
    } catch (error: unknown) {
      if (isDuplicateRunError(error)) {
        io.stderr(`cannot start run "${handle.id}": run already exists`);
        return EXIT_USAGE;
      }
      throw error;
    }
  } finally {
    await store.close?.();
  }

  return reportOutcome(outcome, json, io);
}

/** Read a bounded snapshot of a run's persisted events (no live follow). */
async function readEventSnapshot(
  store: RunStore,
  runId: string,
  revision: number,
): Promise<PersistedRunEvent[]> {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`run "${runId}" has invalid revision ${String(revision)}`);
  }
  const iterator = store.readEvents(runId)[Symbol.asyncIterator]();
  const events: PersistedRunEvent[] = [];
  try {
    for (let sequence = 0; sequence < revision; sequence += 1) {
      const next = await iterator.next();
      if (next.done) {
        throw new Error(
          `run "${runId}" ended before event sequence ${String(sequence)}`,
        );
      }
      if (next.value.seq !== sequence) {
        throw new Error(
          `run "${runId}" expected event sequence ${String(sequence)}, received ${String(next.value.seq)}`,
        );
      }
      events.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  return events;
}

async function resolveRunId(
  store: RunStore,
  requestedRunId: string | undefined,
  preferRunning = false,
): Promise<string> {
  if (requestedRunId !== undefined) {
    return requestedRunId;
  }
  const runs = await store.listRuns();
  const selected =
    (preferRunning ? runs.find((run) => !run.finished) : undefined) ?? runs[0];
  if (selected === undefined) {
    throw new Error("no persisted runs exist for the current project");
  }
  return selected.runId;
}

async function inspectCommand(
  invocation: ReadInvocation,
  io: CliIo,
): Promise<number> {
  let store: RunStore | undefined;
  try {
    store = await openPersistentStore(invocation.store);
    const inspection = await inspectRun(store, invocation.runId);
    if (invocation.json) {
      io.stdout(
        stringifyJson({
          version: 1,
          runId: inspection.runId,
          finished: inspection.finished,
          nodes: inspection.nodes,
          failures: inspection.failures,
          timing: inspection.timing,
        }),
      );
    } else {
      for (const node of inspection.nodes) {
        // The bare `nodeId: state` line is parsed by scripts — keep it
        // byte-stable and put timing on its own indented detail line.
        io.stdout(`${node.nodeId}: ${node.state}`);
        if (node.timing !== null) {
          io.stdout(
            `  time: ${formatDuration(node.timing.totalDurationMs)} · ${formatPhaseSummary(node.timing.phases)}`,
          );
        }
      }
      for (const failure of inspection.failures) {
        io.stdout(`failure ${failure.nodeId}: ${stringifyJson(failure.cause)}`);
      }
      if (inspection.timing === null) {
        io.stdout("timing: unavailable (empty or legacy event log)");
      } else {
        io.stdout(
          `elapsed: ${formatDuration(inspection.timing.totalDurationMs)}`,
        );
        io.stdout(
          `critical path: ${inspection.timing.criticalPath.nodeIds.join(" -> ")} · ${formatDuration(inspection.timing.criticalPath.durationMs)}`,
        );
        io.stdout(
          `largest waits: ${formatPhaseSummary(inspection.timing.waitingPhases)}`,
        );
        io.stdout(
          `attribution: ${(inspection.timing.attributionCoverage * 100).toFixed(1)}%`,
        );
      }
      io.stdout(`finished: ${String(inspection.finished)}`);
    }
    return EXIT_SUCCESS;
  } catch (error: unknown) {
    io.stderr(`cannot inspect "${invocation.runId}": ${describeError(error)}`);
    return EXIT_USAGE;
  } finally {
    await store?.close?.();
  }
}

function formatPhaseSummary(phases: readonly PhaseDuration[]): string {
  const visible = phases.filter((phase) => phase.durationMs > 0).slice(0, 3);
  return visible.length === 0
    ? "none"
    : visible
        .map((phase) => `${phase.phase} ${formatDuration(phase.durationMs)}`)
        .join(", ");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${String(durationMs)}ms`;
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = ((durationMs % 60_000) / 1_000).toFixed(1);
  return `${String(minutes)}m ${seconds}s`;
}

function isDuplicateRunError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/^run already exists:/u.test(error.message) ||
      /UNIQUE constraint failed:\s*runs\.run_id/iu.test(error.message))
  );
}

async function eventsCommand(
  invocation: ReadInvocation,
  io: CliIo,
): Promise<number> {
  let store: RunStore | undefined;
  try {
    store = await openPersistentStore(invocation.store);
    const run = await store.getRun(invocation.runId);
    if (run === undefined) {
      io.stderr(`unknown run: "${invocation.runId}"`);
      return EXIT_USAGE;
    }
    const events = await readEventSnapshot(
      store,
      invocation.runId,
      run.revision,
    );
    if (invocation.json) {
      io.stdout(stringifyJson({ version: 1, runId: invocation.runId, events }));
    } else {
      for (const event of events) {
        io.stdout(`${String(event.seq)} ${event.kind} ${event.nodeId}`);
      }
    }
    return EXIT_SUCCESS;
  } catch (error: unknown) {
    io.stderr(
      `cannot read events for "${invocation.runId}": ${describeError(error)}`,
    );
    return EXIT_USAGE;
  } finally {
    await store?.close?.();
  }
}

interface WorkerLogEntry {
  readonly nodeId: string;
  readonly attempt: number;
  readonly text: string;
}

const ACTIVE_LOG_TAIL_LINES = 20;

async function collectWorkerLogs(
  store: RunStore,
  logBackend: LogBackend,
  runId: string,
): Promise<readonly WorkerLogEntry[]> {
  const run = await store.getRun(runId);
  if (run === undefined) {
    throw new Error(`unknown run: "${runId}"`);
  }
  const events = await readEventSnapshot(store, runId, run.revision);
  const attemptCounts = new Map<string, number>();
  let targets: { readonly nodeId: string; readonly attempt: number }[] = [];
  for (const event of events) {
    if (event.kind === "node_reset") {
      attemptCounts.delete(event.nodeId);
      targets = targets.filter((target) => target.nodeId !== event.nodeId);
    } else if (event.kind === "node_started") {
      const attempt = (attemptCounts.get(event.nodeId) ?? 0) + 1;
      attemptCounts.set(event.nodeId, attempt);
      targets.push(Object.freeze({ nodeId: event.nodeId, attempt }));
    }
  }

  const entries: WorkerLogEntry[] = [];
  for (const { nodeId, attempt } of targets) {
    let text = "";
    for await (const chunk of logBackend.read({ runId, nodeId, attempt })) {
      text += chunk;
    }
    if (text.length > 0) {
      entries.push(Object.freeze({ nodeId, attempt, text }));
    }
  }
  return Object.freeze(entries);
}

function workerLogKey(entry: WorkerLogEntry): string {
  return `${entry.nodeId}\u0000${String(entry.attempt)}`;
}

function printWorkerLogChunk(
  entry: WorkerLogEntry,
  chunk: string,
  printHeader: boolean,
  io: CliIo,
): void {
  if (printHeader) {
    io.stdout(`==> ${entry.nodeId} (attempt ${String(entry.attempt)}) <==`);
  }
  io.stdout(chunk.replace(/\n$/u, ""));
}

async function followWorkerLogs(
  store: RunStore,
  logBackend: LogBackend,
  runId: string,
  io: CliIo,
): Promise<void> {
  const emittedLengths = new Map<string, number>();
  let emittedAny = false;
  let attached = false;
  while (true) {
    const run = await store.getRun(runId);
    if (run === undefined) {
      throw new Error(`unknown run: "${runId}"`);
    }
    const entries = await collectWorkerLogs(store, logBackend, runId);
    for (const entry of entries) {
      const key = workerLogKey(entry);
      const previousLength =
        emittedLengths.get(key) ??
        (!run.finished && !attached
          ? logTailOffset(entry.text, ACTIVE_LOG_TAIL_LINES)
          : 0);
      const offset = previousLength <= entry.text.length ? previousLength : 0;
      const chunk = entry.text.slice(offset);
      if (chunk.length > 0) {
        printWorkerLogChunk(entry, chunk, offset === 0, io);
        emittedAny = true;
      }
      emittedLengths.set(key, entry.text.length);
    }
    attached = true;
    if (run.finished) {
      if (!emittedAny) {
        io.stderr(`no worker logs for run "${runId}"`);
      }
      return;
    }
    await createSystemClock().wait(500);
  }
}

function logTailOffset(text: string, lineCount: number): number {
  let offset = text.length;
  for (let line = 0; line < lineCount; line += 1) {
    const previousNewline = text.lastIndexOf("\n", Math.max(0, offset - 2));
    if (previousNewline < 0) {
      return 0;
    }
    offset = previousNewline + 1;
  }
  return offset;
}

async function logsCommand(
  invocation: LogsInvocation,
  io: CliIo,
): Promise<number> {
  let store: RunStore | undefined;
  let logBackend: LogBackend | undefined;
  let resolvedRunId: string | undefined;
  try {
    const projectPaths = resolvePrismProjectPaths(invocation.repo);
    if (projectPaths.logBaseDir === undefined) {
      throw new Error(
        "PRISM_HOME is not set; worker logs require the project logs/ directory under PRISM_HOME",
      );
    }
    store = await openPersistentStore(invocation.store, invocation.repo);
    resolvedRunId = await resolveRunId(store, invocation.runId, true);
    logBackend = createFileLogBackend({
      baseDir: projectPaths.logBaseDir,
    });
    if (invocation.json) {
      const logs = await collectWorkerLogs(store, logBackend, resolvedRunId);
      io.stdout(stringifyJson({ version: 1, runId: resolvedRunId, logs }));
    } else {
      await followWorkerLogs(store, logBackend, resolvedRunId, io);
    }
    return EXIT_SUCCESS;
  } catch (error: unknown) {
    const target = resolvedRunId ?? invocation.runId ?? "latest run";
    io.stderr(`cannot read logs for "${target}": ${describeError(error)}`);
    return EXIT_USAGE;
  } finally {
    await logBackend?.close?.();
    await store?.close?.();
  }
}

async function resumeCommand(
  invocation: ResumeInvocation,
  io: CliIo,
): Promise<number> {
  let store: RunStore | undefined;
  try {
    const projectPaths = resolvePrismProjectPaths(invocation.agent.repo);
    if (projectPaths.prismHome === undefined) {
      throw new Error(executionPrismHomeMessage());
    }
    store = await openPersistentStore(invocation.store, invocation.agent.repo);
    const engine = createEngine({
      store,
      registry: createAgentExecutorRegistry({
        ...(invocation.agent.repo === undefined
          ? {}
          : { repoDir: invocation.agent.repo }),
        ...(invocation.agent.worktreeDir === undefined
          ? {}
          : { worktreeBaseDir: invocation.agent.worktreeDir }),
        ...(invocation.agent.codexCommand === undefined
          ? {}
          : { codexCommand: invocation.agent.codexCommand }),
        ...(invocation.agent.codexModel === undefined
          ? {}
          : { codexModel: invocation.agent.codexModel }),
        ...(invocation.agent.codexReasoningEffort === undefined
          ? {}
          : {
              codexReasoningEffort: invocation.agent.codexReasoningEffort,
            }),
      }),
      maxConcurrency: invocation.agent.maxConcurrency,
    });
    const handle = engine.resume(invocation.runId);
    io.stderr(`resume ${handle.id}`);
    const outcome = await handle.result;
    return reportOutcome(outcome, invocation.json, io);
  } catch (error: unknown) {
    io.stderr(`cannot resume "${invocation.runId}": ${describeError(error)}`);
    return EXIT_USAGE;
  } finally {
    await store?.close?.();
  }
}

function executionPrismHomeMessage(): string {
  return "PRISM_HOME is not set; prism run and prism resume require it for durable worker logs and worktrees, even when --store is provided";
}

async function abortCommand(
  invocation: AbortInvocation,
  io: CliIo,
): Promise<number> {
  let store: RunStore | undefined;
  try {
    store = await openPersistentStore(invocation.store);
    await abortRun(store, invocation.runId);
    io.stderr(`aborted ${invocation.runId}`);
    if (invocation.json) {
      io.stdout(stringifyJson({ version: 1, aborted: invocation.runId }));
    }
    return EXIT_SUCCESS;
  } catch (error: unknown) {
    io.stderr(`cannot abort "${invocation.runId}": ${describeError(error)}`);
    return EXIT_USAGE;
  } finally {
    await store?.close?.();
  }
}

async function resetCommand(
  invocation: NodeTargetInvocation,
  io: CliIo,
): Promise<number> {
  let store: RunStore | undefined;
  try {
    store = await openPersistentStore(invocation.store);
    await resetRun(
      store,
      invocation.runId,
      [invocation.nodeId],
      invocation.command === "rerun-node" ? { includeDownstream: true } : {},
    );
    io.stderr(`reset ${invocation.runId}/${invocation.nodeId}`);
    if (invocation.json) {
      io.stdout(
        stringifyJson({
          version: 1,
          runId: invocation.runId,
          reset: invocation.nodeId,
          includeDownstream: invocation.command === "rerun-node",
        }),
      );
    }
    return EXIT_SUCCESS;
  } catch (error: unknown) {
    io.stderr(
      `cannot ${invocation.command} "${invocation.runId}/${invocation.nodeId}": ${describeError(error)}`,
    );
    return EXIT_USAGE;
  } finally {
    await store?.close?.();
  }
}

async function statusCommand(
  invocation: StatusInvocation,
  io: CliIo,
): Promise<number> {
  let store: RunStore | undefined;
  try {
    store = await openPersistentStore(invocation.store);
    const runs = await store.listRuns();
    if (invocation.json) {
      io.stdout(stringifyJson({ version: 1, runs }));
    } else {
      for (const run of runs) {
        io.stdout(`${run.runId}\t${run.finished ? "finished" : "running"}`);
      }
    }
    return EXIT_SUCCESS;
  } catch (error: unknown) {
    io.stderr(`cannot list runs: ${describeError(error)}`);
    return EXIT_USAGE;
  } finally {
    await store?.close?.();
  }
}

function printWatchSnapshot(
  inspection: RunInspection,
  json: boolean,
  io: CliIo,
): void {
  if (json) {
    io.stdout(
      stringifyJson({
        version: 1,
        runId: inspection.runId,
        finished: inspection.finished,
        nodes: inspection.nodes,
        failures: inspection.failures,
      }),
    );
    return;
  }

  io.stdout(
    `run ${inspection.runId}: ${inspection.finished ? "finished" : "running"}`,
  );
  for (const node of inspection.nodes) {
    io.stdout(`${node.nodeId}: ${node.state}`);
  }
  for (const failure of inspection.failures) {
    io.stdout(`failure ${failure.nodeId}: ${stringifyJson(failure.cause)}`);
  }
}

function inspectionFailed(inspection: RunInspection): boolean {
  return inspection.nodes.some((node) => node.state !== "succeeded");
}

async function watchCommand(
  invocation: WatchInvocation,
  io: CliIo,
): Promise<number> {
  let store: RunStore | undefined;
  let resolvedRunId: string | undefined;
  try {
    store = await openPersistentStore(invocation.store, invocation.repo);
    resolvedRunId = await resolveRunId(store, invocation.runId, true);
    const run = await store.getRun(resolvedRunId);
    if (run === undefined) {
      throw new Error(`unknown run: "${resolvedRunId}"`);
    }
    let terminal: RunInspection | undefined;
    let frame = 0;
    for await (const inspection of watchRun(store, resolvedRunId, {
      clock: createSystemClock(),
      intervalMs: invocation.intervalMs,
    })) {
      if (io.interactive === true && !invocation.json) {
        const dashboard = renderWatchDashboard(run.graph, inspection, {
          ...(io.columns === undefined ? {} : { columns: io.columns }),
          ...(io.rows === undefined ? {} : { rows: io.rows }),
          ...(io.color === undefined ? {} : { color: io.color }),
          frame,
        });
        const screen = `\u001B[2J\u001B[H${dashboard}\n`;
        if (io.write === undefined) {
          io.stdout(screen);
        } else {
          io.write(screen);
        }
      } else {
        printWatchSnapshot(inspection, invocation.json, io);
      }
      terminal = inspection;
      frame += 1;
    }
    if (terminal === undefined) {
      throw new Error(`watch produced no snapshots for "${resolvedRunId}"`);
    }
    return inspectionFailed(terminal) ? EXIT_RUN_FAILED : EXIT_SUCCESS;
  } catch (error: unknown) {
    const target = resolvedRunId ?? invocation.runId ?? "latest run";
    io.stderr(`cannot watch "${target}": ${describeError(error)}`);
    return EXIT_USAGE;
  } finally {
    await store?.close?.();
  }
}

async function skillsCommand(
  invocation: SkillsInvocation,
  io: CliIo,
): Promise<number> {
  const available = await listBundledSkills();
  if (available.length === 0) {
    io.stderr("no skills are bundled with this Prism installation");
    return EXIT_USAGE;
  }

  if (invocation.action === "list") {
    if (invocation.json) {
      io.stdout(
        JSON.stringify(
          available.map((skill) => ({
            name: skill.name,
            description: skill.description,
            path: skill.sourceDir,
          })),
        ),
      );
      return EXIT_SUCCESS;
    }
    for (const skill of available) {
      io.stdout(skill.name);
      if (skill.description.length > 0) {
        io.stderr(`  ${skill.description}`);
      }
    }
    return EXIT_SUCCESS;
  }

  const selected =
    invocation.names.length === 0
      ? available
      : available.filter((skill) => invocation.names.includes(skill.name));
  const unknown = invocation.names.filter(
    (name) => !available.some((skill) => skill.name === name),
  );
  if (unknown.length > 0) {
    io.stderr(
      `unknown skill: ${unknown.join(", ")}; available: ${available
        .map((skill) => skill.name)
        .join(", ")}`,
    );
    return EXIT_USAGE;
  }

  const { repoDir } = resolvePrismProjectPaths(
    invocation.repo ?? process.cwd(),
  );
  const targetDir = resolveSkillsInstallDir(
    invocation.agent,
    invocation.scope,
    repoDir,
  );

  try {
    await mkdir(targetDir, { recursive: true });
    const installed = await installSkills(
      selected,
      targetDir,
      invocation.force,
    );
    if (invocation.json) {
      io.stdout(JSON.stringify(installed));
    } else {
      for (const skill of installed) {
        io.stdout(skill.path);
      }
    }
    io.stderr(
      `installed ${String(installed.length)} skill(s) into ${targetDir}; restart your agent session to pick them up`,
    );
    return EXIT_SUCCESS;
  } catch (error: unknown) {
    io.stderr(`cannot install skills: ${describeError(error)}`);
    return EXIT_USAGE;
  }
}

/**
 * Dispatch. stdout carries data only; diagnostics and the run id go to
 * stderr. Exit codes: 0 success, 1 graph run failed, 2 invalid input or
 * usage, 3 unexpected internal error (assigned by main.ts).
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  const invocation = parseInvocation(argv);
  if (invocation === undefined) {
    io.stderr(USAGE);
    return EXIT_USAGE;
  }

  switch (invocation.command) {
    // Requested help is data, not a usage error: stdout, exit 0.
    case "help":
      io.stdout(USAGE);
      return EXIT_SUCCESS;

    case "skills":
      return skillsCommand(invocation, io);

    case "beads-dag":
      try {
        await generateBeadsDag({
          repoDir: invocation.repo ?? process.cwd(),
          ...(invocation.beadsRepo === undefined
            ? {}
            : { beadsRepoDir: invocation.beadsRepo }),
          outFile: invocation.out,
          bdCommand: invocation.bdCommand,
          ...(invocation.specFile === undefined
            ? {}
            : { specFile: invocation.specFile }),
          ids: invocation.ids,
          statuses: invocation.statuses,
          labels: invocation.labels,
          targetBranch: invocation.targetBranch,
          branchPrefix: invocation.branchPrefix,
          validationCommands: invocation.validationCommands,
          mergeValidationCommands: invocation.mergeValidationCommands,
          maxIterations: invocation.maxIterations,
          reviewer: invocation.reviewer,
          ...(invocation.greptileAppSlug === undefined
            ? {}
            : { greptileAppSlug: invocation.greptileAppSlug }),
          minConfidenceScore: invocation.minConfidenceScore,
          requireNoActionableFindings: invocation.requireNoActionableFindings,
          requireGreenChecks: invocation.requireGreenChecks,
          ...(invocation.reviewTriggerComment === undefined
            ? {}
            : { reviewTriggerComment: invocation.reviewTriggerComment }),
          includeMerge: invocation.includeMerge,
          includeBeadsUpdate:
            invocation.includeMerge && invocation.includeBeadsUpdate,
          serializeMerges: invocation.serializeMerges,
          ...(invocation.finalPrBase === undefined
            ? {}
            : {
                finalPrBase: invocation.finalPrBase,
                finalPrReviewer: invocation.finalPrReviewer,
                ...(invocation.finalPrReviewTriggerComment === undefined
                  ? {}
                  : {
                      finalPrReviewTriggerComment:
                        invocation.finalPrReviewTriggerComment,
                    }),
                finalPrValidationCommands: invocation.finalPrValidationCommands,
                finalPrMaxIterations: invocation.finalPrMaxIterations,
                finalPrDraft: invocation.finalPrDraft,
              }),
        });
        io.stdout(invocation.out);
        return EXIT_SUCCESS;
      } catch (error: unknown) {
        io.stderr(`cannot generate Beads DAG: ${describeError(error)}`);
        return EXIT_USAGE;
      }

    case "validate":
    case "graph":
    case "run": {
      const graph = await loadGraph(invocation.file, io);
      if (graph === undefined) {
        return EXIT_USAGE;
      }
      if (invocation.command === "validate") {
        return EXIT_SUCCESS;
      }
      if (invocation.command === "graph") {
        if (invocation.json) {
          printJsonGraph(graph, io);
        } else {
          printTextGraph(graph, io);
        }
        return EXIT_SUCCESS;
      }
      return runGraph(graph, invocation, io);
    }

    case "inspect":
      return inspectCommand(invocation, io);

    case "events":
      return eventsCommand(invocation, io);

    case "logs":
      return logsCommand(invocation, io);

    case "status":
      return statusCommand(invocation, io);

    case "watch":
      return watchCommand(invocation, io);

    case "resume":
      return resumeCommand(invocation, io);

    case "abort":
      return abortCommand(invocation, io);

    case "signal":
    case "rerun-node":
      return resetCommand(invocation, io);

    default: {
      const unhandledCommand: never = invocation;
      throw new Error(`unhandled command: ${JSON.stringify(unhandledCommand)}`);
    }
  }
}
