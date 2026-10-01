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
  applyAdminRequestOffline,
  compileGraph,
  createEngine,
  createMemoryStore,
  createSystemClock,
  describeFailure,
  inspectRun,
  parseGraph,
  resetRun,
  transientInfraRetryPolicy,
  watchRun,
} from "@rsetia/prism";
import type {
  AdminRequest,
  CompiledGraph,
  FailureDescription,
  GraphCompileError,
  GraphParseError,
  NodeFailure,
  ProofOfWorkV1,
  PhaseDuration,
  PersistedRunEvent,
  LogBackend,
  RunInspection,
  RunOutcome,
  RunStore,
} from "@rsetia/prism";
import {
  buildPollGraph,
  createFileLogBackend,
  createSqliteStore,
  parsePollConfig,
  POLL_EXECUTOR,
  POLL_NODE_ID,
  pollConfigToJson,
  pollGraphProposalPolicy,
  pollRunId,
} from "@rsetia/prism/node";
import type { PollConfig } from "@rsetia/prism/node";
import {
  createAgentExecutorRegistry,
  createPollSources,
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
/** Automatic in-run retries of explicitly transient_infra failures. */
export const DEFAULT_MAX_TRANSIENT_RETRIES = 3;
/** How long signal / rerun-node wait for a live coordinator. */
export const DEFAULT_ADMIN_TIMEOUT_MS = 60_000;

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
             [--codex-reasoning-effort <level>] [--codex-backend exec|app-server]
             [--greptile-app-slug <slug>] [--max-transient-retries <n>]
                                      Execute the graph (transient infrastructure
                                      failures, e.g. git lock races, are retried
                                      in-run; --max-transient-retries 0 disables)
  poll <config> [--json] [--store <db>] [--run-id <id>] [--repo <path>]
              [--max-concurrency <n>] [--codex-bin <path>] [--codex-model <id>]
              [--codex-reasoning-effort <level>] [--codex-backend exec|app-server]
              [--max-transient-retries <n>]
                                      Watch a source (Linear) and implement every
                                      newly matching item; restarting resumes the
                                      same poll run (default id poll-<name>)
  inspect <run-id> [--store <db>] [--json]
                                      Show a persisted run's node states
  events <run-id> [--store <db>] [--json]
                                      Show a persisted run's event log
  logs [<run-id>] [--store <db>] [--json] [--repo <path>]
                                      Follow worker output (default: every
                                      unfinished run, lines prefixed by run;
                                      else the latest run)
  status [--store <db>] [--json]      List persisted runs
  watch [<run-id>] [--store <db>] [--json] [--interval <ms>] [--repo <path>]
                                      Render the live DAG (default: every
                                      unfinished run, stacked; else the latest)
  resume <run-id> [--store <db>] [--json] [--repo <path>]
         [--max-concurrency <n>] [--codex-bin <path>] [--codex-model <id>]
         [--codex-reasoning-effort <level>] [--codex-backend exec|app-server]
         [--max-transient-retries <n>]
                                      Continue an interrupted run to completion
                                      (a finished run is reopened to re-run
                                      transient_infra failures, e.g. git lock
                                      races; timeouts need rerun-node)
  abort <run-id> [--store <db>] [--json]
                                      Force a stuck run to a cancelled, finished state
  signal <run-id> <node-id> [--store <db>] [--json] [--timeout <ms>]
                                      Reset a node (and its blocked/skipped
                                      dependents). A live run applies it and
                                      re-runs the node itself; otherwise it is
                                      applied offline for a later resume
  rerun-node <run-id> <node-id> [--store <db>] [--json] [--timeout <ms>]
                                      Reset a node and its downstream. A live
                                      run re-runs them in place (resetting only
                                      failed/blocked/cancelled/skipped
                                      dependents); otherwise every dependent,
                                      even succeeded ones, is reset for resume

Defaults:
  Repository                            Current git repository
  Beads, store, worktrees, and logs     $PRISM_HOME/<kind>/<project>/...
  Skill install target                  ~/.claude/skills
  Pull-request reviewer                 Greptile (@greptile review)
  Maximum concurrency                   ${String(DEFAULT_MAX_CONCURRENCY)}
  Codex model                           ${DEFAULT_CODEX_MODEL}
  Codex reasoning effort                ${DEFAULT_CODEX_REASONING_EFFORT}
  Codex backend                         exec`;

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
interface PollInvocation {
  readonly command: "poll";
  readonly file: string;
  readonly json: boolean;
  readonly store: string | undefined;
  readonly runId: string | undefined;
  /** Whether --max-concurrency was passed; otherwise the config decides. */
  readonly maxConcurrencyExplicit: boolean;
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
  /** How long to wait for a live coordinator to acknowledge, in ms. */
  readonly timeoutMs: number;
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
  | PollInvocation
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
  readonly codexBackend: "exec" | "app-server";
  readonly worktreeDir: string | undefined;
  /** Automatic in-run retries of transient_infra failures; 0 disables. */
  readonly maxTransientRetries: number;
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
  readonly codexBackend: string | undefined;
  readonly worktreeDir: string | undefined;
  readonly greptileAppSlug: string | undefined;
  readonly maxTransientRetries: string | undefined;
  readonly timeout: string | undefined;
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
  let codexBackend: string | undefined;
  let worktreeDir: string | undefined;
  let greptileAppSlug: string | undefined;
  let maxTransientRetries: string | undefined;
  let timeout: string | undefined;

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
      arg === "--codex-backend" ||
      arg === "--worktree-dir" ||
      arg === "--greptile-app-slug" ||
      arg === "--max-transient-retries" ||
      arg === "--timeout"
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
      } else if (arg === "--codex-backend") {
        if (codexBackend !== undefined) return undefined;
        codexBackend = value;
      } else if (arg === "--worktree-dir") {
        if (worktreeDir !== undefined) return undefined;
        worktreeDir = value;
      } else if (arg === "--max-transient-retries") {
        if (maxTransientRetries !== undefined) return undefined;
        maxTransientRetries = value;
      } else if (arg === "--timeout") {
        if (timeout !== undefined) return undefined;
        timeout = value;
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
    codexBackend,
    worktreeDir,
    greptileAppSlug,
    maxTransientRetries,
    timeout,
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
  // --timeout belongs to the live-reset commands only.
  if (
    flags.timeout !== undefined &&
    command !== "signal" &&
    command !== "rerun-node"
  ) {
    return undefined;
  }

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
    case "poll": {
      if (
        count !== 1 ||
        first === undefined ||
        flags.interval !== undefined ||
        flags.greptileAppSlug !== undefined
      ) {
        return undefined;
      }
      const agent = parseAgentOptions(flags);
      if (agent === undefined) return undefined;
      return {
        command,
        file: first,
        json: flags.json,
        store: flags.store,
        runId: flags.runId,
        maxConcurrencyExplicit: flags.maxConcurrency !== undefined,
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
    case "rerun-node": {
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
      const timeoutMs =
        flags.timeout === undefined
          ? DEFAULT_ADMIN_TIMEOUT_MS
          : Number(flags.timeout);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
        return undefined;
      }
      return {
        command,
        runId: first,
        nodeId: second,
        json: flags.json,
        store: flags.store,
        timeoutMs,
      };
    }
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
    flags.maxTransientRetries === undefined &&
    flags.repo === undefined &&
    flags.maxConcurrency === undefined &&
    flags.codexCommand === undefined &&
    flags.codexModel === undefined &&
    flags.codexReasoningEffort === undefined &&
    flags.codexBackend === undefined &&
    flags.worktreeDir === undefined &&
    flags.greptileAppSlug === undefined
  );
}

function noWorkerFlags(flags: ParsedFlags): boolean {
  return (
    flags.maxTransientRetries === undefined &&
    flags.maxConcurrency === undefined &&
    flags.codexCommand === undefined &&
    flags.codexModel === undefined &&
    flags.codexReasoningEffort === undefined &&
    flags.codexBackend === undefined &&
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
  const codexBackend = flags.codexBackend ?? "exec";
  if (codexBackend !== "exec" && codexBackend !== "app-server") {
    return undefined;
  }
  const maxTransientRetries =
    flags.maxTransientRetries === undefined
      ? DEFAULT_MAX_TRANSIENT_RETRIES
      : Number(flags.maxTransientRetries);
  if (!Number.isSafeInteger(maxTransientRetries) || maxTransientRetries < 0) {
    return undefined;
  }
  return {
    maxTransientRetries,
    repo: flags.repo,
    maxConcurrency,
    codexCommand: flags.codexCommand,
    codexModel: flags.codexModel,
    codexReasoningEffort: flags.codexReasoningEffort,
    codexBackend,
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
      readonly resources: readonly string[];
      readonly dependents: readonly string[];
    }
  > = Object.create(null) as Record<
    string,
    {
      readonly executor: string;
      readonly kind: CompiledGraph["nodes"][string]["kind"];
      readonly dependsOn: readonly string[];
      readonly resources: readonly string[];
      readonly dependents: readonly string[];
    }
  >;

  for (const nodeId of graph.order) {
    const node = getCompiledNode(graph, nodeId);
    nodes[nodeId] = {
      executor: node.executor,
      kind: node.kind,
      dependsOn: node.dependsOn,
      resources: node.resources,
      dependents: node.dependents,
    };
  }

  io.stdout(
    stringifyJson({
      version: 1,
      resources: graph.resources,
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
  let agentRegistry: ReturnType<typeof createAgentExecutorRegistry> | undefined;
  try {
    agentRegistry = createAgentExecutorRegistry({
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
      codexBackend: invocation.agent.codexBackend,
    });
    const engine = createEngine({
      store,
      registry: agentRegistry,
      maxConcurrency: invocation.agent.maxConcurrency,
      graphProposalPolicy: pollGraphProposalPolicy,
      retryPolicy: transientInfraRetryPolicy(
        invocation.agent.maxTransientRetries,
      ),
      clock: createSystemClock(),
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
    await agentRegistry?.close();
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
          graphRevisions: inspection.graphRevisions ?? [],
          timing: inspection.timing,
          leases: inspection.leases,
          usage: inspection.usage ?? null,
          scheduler: inspection.scheduler ?? null,
          failureDetails: describeFailures(inspection),
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
        if (node.evidence !== null) {
          io.stdout(`  evidence: ${formatEvidenceSummary(node.evidence)}`);
        }
      }
      const usage = inspection.usage;
      if (usage !== undefined && usage !== null) {
        io.stdout(
          `usage: ${usage.inputTokens ?? "unknown"} input tokens · ${usage.outputTokens ?? "unknown"} output tokens · ${usage.costUsd === null ? "cost unknown" : `$${usage.costUsd.toFixed(4)} ${usage.costKind}`}`,
        );
      }
      io.stdout(
        `realized concurrency: ${String(inspection.scheduler?.maximumRealizedNodeConcurrency ?? 0)}`,
      );
      const resourceLockUtilization =
        inspection.scheduler?.resourceLockUtilization;
      io.stdout(
        resourceLockUtilization === null ||
          resourceLockUtilization === undefined
          ? "resource-lock utilization: unknown"
          : `resource-lock utilization: ${(resourceLockUtilization * 100).toFixed(1)}%`,
      );
      printFailureLines(inspection, io);
      for (const revision of inspection.graphRevisions ?? []) {
        io.stdout(
          `graph revision ${String(revision.graphRevision)}: ${revision.decision.status} · ${revision.proposal.proposer} · ${revision.addedNodeIds.join(", ") || "no nodes"}`,
        );
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

function formatEvidenceSummary(evidence: ProofOfWorkV1): string {
  const passed = evidence.validations.filter(
    (validation) => validation.status === "passed",
  ).length;
  return `${evidence.summary} · ${String(evidence.commits.length)} commit(s) · ${String(evidence.pullRequests.length)} PR(s) · ${String(passed)}/${String(evidence.validations.length)} validation(s) passed · ${String(evidence.unresolvedRisks.length)} unresolved risk(s)`;
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
  prefix = "",
): void {
  if (printHeader) {
    io.stdout(
      `${prefix}==> ${entry.nodeId} (attempt ${String(entry.attempt)}) <==`,
    );
  }
  const text = chunk.replace(/\n$/u, "");
  io.stdout(
    prefix === ""
      ? text
      : text
          .split("\n")
          .map((line) => `${prefix}${line}`)
          .join("\n"),
  );
}

/** A short, stable label for prefixing one run's output among several. */
function shortRunId(runId: string): string {
  return runId.replace(/^run-/u, "").slice(0, 8);
}

async function followWorkerLogs(
  store: RunStore,
  logBackend: LogBackend,
  runId: string,
  io: CliIo,
  prefix = "",
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
        printWorkerLogChunk(entry, chunk, offset === 0, io, prefix);
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
    logBackend = createFileLogBackend({
      baseDir: projectPaths.logBaseDir,
    });
    const unfinished =
      invocation.runId === undefined
        ? (await store.listRuns()).filter((run) => !run.finished)
        : [];
    if (unfinished.length > 1) {
      // Several runs are active: show all of them, not just the newest.
      const runIds = unfinished.map((run) => run.runId);
      if (invocation.json) {
        const runs = [];
        for (const runId of runIds) {
          runs.push({
            runId,
            logs: await collectWorkerLogs(store, logBackend, runId),
          });
        }
        io.stdout(stringifyJson({ version: 1, runs }));
      } else {
        const activeStore = store;
        const activeBackend = logBackend;
        await Promise.all(
          runIds.map((runId) =>
            followWorkerLogs(
              activeStore,
              activeBackend,
              runId,
              io,
              `[${shortRunId(runId)}] `,
            ),
          ),
        );
      }
      return EXIT_SUCCESS;
    }
    resolvedRunId = await resolveRunId(store, invocation.runId, true);
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
  let agentRegistry: ReturnType<typeof createAgentExecutorRegistry> | undefined;
  try {
    const projectPaths = resolvePrismProjectPaths(invocation.agent.repo);
    if (projectPaths.prismHome === undefined) {
      throw new Error(executionPrismHomeMessage());
    }
    store = await openPersistentStore(invocation.store, invocation.agent.repo);
    agentRegistry = createAgentExecutorRegistry({
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
      codexBackend: invocation.agent.codexBackend,
    });
    const engine = createEngine({
      store,
      registry: agentRegistry,
      maxConcurrency: invocation.agent.maxConcurrency,
      graphProposalPolicy: pollGraphProposalPolicy,
      retryPolicy: transientInfraRetryPolicy(
        invocation.agent.maxTransientRetries,
      ),
      clock: createSystemClock(),
    });
    const handle = engine.resume(invocation.runId);
    io.stderr(`resume ${handle.id}`);
    const outcome = await handle.result;
    return reportOutcome(outcome, invocation.json, io);
  } catch (error: unknown) {
    io.stderr(`cannot resume "${invocation.runId}": ${describeError(error)}`);
    return EXIT_USAGE;
  } finally {
    await agentRegistry?.close();
    await store?.close?.();
  }
}

function agentRegistryFor(
  agent: AgentInvocationOptions,
  pollLog?: (line: string) => void,
): ReturnType<typeof createAgentExecutorRegistry> {
  return createAgentExecutorRegistry({
    ...(agent.repo === undefined ? {} : { repoDir: agent.repo }),
    ...(agent.worktreeDir === undefined
      ? {}
      : { worktreeBaseDir: agent.worktreeDir }),
    ...(agent.codexCommand === undefined
      ? {}
      : { codexCommand: agent.codexCommand }),
    ...(agent.codexModel === undefined ? {} : { codexModel: agent.codexModel }),
    ...(agent.codexReasoningEffort === undefined
      ? {}
      : { codexReasoningEffort: agent.codexReasoningEffort }),
    codexBackend: agent.codexBackend,
    ...(pollLog === undefined ? {} : { pollLog }),
  });
}

async function readConfigFile(file: string): Promise<unknown> {
  const source = await readFile(file, "utf8");
  const extension = extname(file).toLowerCase();
  return extension === ".yaml" || extension === ".yml"
    ? (parseYaml(source) as unknown)
    : (JSON.parse(source) as unknown);
}

const DEFAULT_POLL_LEASE_DURATION_MS = 30_000;

/**
 * Lease length for poll runs. It is also the crash-recovery window: after a
 * poller is killed, a restart waits for its leases to lapse. Overridable so
 * tests (and impatient operators) can shorten that window.
 */
function pollLeaseDurationMs(): number {
  const raw = process.env["PRISM_LEASE_DURATION_MS"];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 500
    ? parsed
    : DEFAULT_POLL_LEASE_DURATION_MS;
}

/**
 * A killed poller leaves its coordinator and node leases behind until they
 * expire. Wait them out so a restart resumes instead of failing with a lease
 * conflict, but refuse when the leases keep getting renewed: that is a live
 * poller, and two coordinators must never share a run.
 */
async function waitForAbandonedLeases(
  store: RunStore,
  runId: string,
  leaseDurationMs: number,
  io: CliIo,
): Promise<boolean> {
  let leases = await store.getRunLeases(runId);
  if (leases.length === 0) return true;
  const horizonOf = (current: typeof leases): number =>
    Math.max(...current.map((lease) => lease.expiresAtMs));
  let horizon = horizonOf(leases);
  io.stderr(
    `waiting up to ${String(Math.max(1, Math.ceil((horizon - Date.now()) / 1_000)))}s for the previous poller's leases on "${runId}" to expire`,
  );
  while (true) {
    await new Promise((resolveWait) =>
      setTimeout(
        resolveWait,
        Math.min(1_000, Math.max(100, leaseDurationMs / 4)),
      ),
    );
    leases = await store.getRunLeases(runId);
    if (leases.length === 0) return true;
    const next = horizonOf(leases);
    if (next > horizon) {
      io.stderr(
        `poll run "${runId}" is owned by a running process (its leases are being renewed); stop that prism poll first`,
      );
      return false;
    }
    horizon = next;
  }
}

/** Key-order-independent JSON, so reordering a config file is not drift. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * `prism poll <config>`: one durable run per poll config. The first start
 * creates `poll-<name>` with a single poll node; every later start resumes
 * that run, so a restarted poller keeps everything it already queued and
 * re-enters interrupted implementers through the normal resume path.
 */
async function pollCommand(
  invocation: PollInvocation,
  io: CliIo,
): Promise<number> {
  let config: PollConfig;
  try {
    config = parsePollConfig(await readConfigFile(invocation.file));
  } catch (error: unknown) {
    io.stderr(
      `invalid poll config "${invocation.file}": ${describeError(error)}`,
    );
    return EXIT_USAGE;
  }
  const source = createPollSources().find(
    (candidate) => candidate.kind === config.source.kind,
  );
  if (source === undefined) {
    io.stderr(
      `invalid poll config "${invocation.file}": unknown source "${config.source.kind}" (available: ${createPollSources()
        .map((candidate) => candidate.kind)
        .join(", ")})`,
    );
    return EXIT_USAGE;
  }
  try {
    source.validateConfig(config.source);
  } catch (error: unknown) {
    io.stderr(
      `invalid poll config "${invocation.file}": ${describeError(error)}`,
    );
    return EXIT_USAGE;
  }
  try {
    const projectPaths = resolvePrismProjectPaths(invocation.agent.repo);
    if (projectPaths.prismHome === undefined) {
      throw new Error(executionPrismHomeMessage());
    }
  } catch (error: unknown) {
    io.stderr(`cannot resolve project paths: ${describeError(error)}`);
    return EXIT_USAGE;
  }
  if (source.preflight !== undefined) {
    try {
      io.stderr(await source.preflight(config.source));
    } catch (error: unknown) {
      io.stderr(`cannot reach ${source.kind}: ${describeError(error)}`);
      return EXIT_USAGE;
    }
  }

  const runId = invocation.runId ?? pollRunId(config);
  let store: RunStore | undefined;
  let agentRegistry: ReturnType<typeof createAgentExecutorRegistry> | undefined;
  try {
    store = await openPersistentStore(invocation.store, invocation.agent.repo);
    const existing = await store.getRun(runId);
    let effective = config;
    if (existing !== undefined) {
      const pollNode = existing.graph.nodes[POLL_NODE_ID];
      if (pollNode === undefined || pollNode.executor !== POLL_EXECUTOR) {
        io.stderr(`run "${runId}" is not a poll run; choose another --run-id`);
        return EXIT_USAGE;
      }
      if (existing.finished) {
        io.stderr(
          `poll run "${runId}" already finished (${existing.outcome.status}); start a new one with --run-id <id>`,
        );
        return EXIT_USAGE;
      }
      effective = parsePollConfig(pollNode.config);
      if (
        stableStringify(pollNode.config) !==
        stableStringify(pollConfigToJson(config))
      ) {
        io.stderr(
          `warning: "${invocation.file}" differs from the config stored in poll run "${runId}"; resuming with the stored config. Start a new poll run with --run-id <id> to apply the change.`,
        );
      }
    }

    const leaseDurationMs = pollLeaseDurationMs();
    if (
      existing !== undefined &&
      !(await waitForAbandonedLeases(store, runId, leaseDurationMs, io))
    ) {
      return EXIT_USAGE;
    }

    agentRegistry = agentRegistryFor(invocation.agent, (line) => {
      io.stderr(`${new Date().toISOString()} ${line}`);
    });
    const engine = createEngine({
      store,
      registry: agentRegistry,
      leaseDurationMs,
      // The poll node and a context snapshot hold slots of their own; the
      // semaphore in the graph is what caps implementers.
      maxConcurrency: invocation.maxConcurrencyExplicit
        ? invocation.agent.maxConcurrency
        : effective.maxParallel + 2,
      graphProposalPolicy: pollGraphProposalPolicy,
      retryPolicy: transientInfraRetryPolicy(
        invocation.agent.maxTransientRetries,
      ),
      clock: createSystemClock(),
    });

    let handle: ReturnType<typeof engine.run>;
    if (existing === undefined) {
      const parsed = parseGraph(buildPollGraph(effective));
      if (!parsed.ok) {
        reportGraphErrors(parsed.errors, io);
        return EXIT_INTERNAL;
      }
      const compiled = compileGraph(parsed.graph);
      if (!compiled.ok) {
        reportGraphErrors(compiled.errors, io);
        return EXIT_INTERNAL;
      }
      handle = engine.run(compiled.graph, { runId });
      io.stderr(`run ${handle.id}`);
    } else {
      handle = engine.resume(runId);
      io.stderr(`resume ${handle.id}`);
    }
    io.stderr(
      `polling ${effective.source.kind} every ${String(effective.intervalSeconds)}s with up to ${String(effective.maxParallel)} implementers; follow with: prism watch ${runId}`,
    );
    const outcome = await handle.result;
    return reportOutcome(outcome, invocation.json, io);
  } catch (error: unknown) {
    io.stderr(`cannot poll "${runId}": ${describeError(error)}`);
    return EXIT_USAGE;
  } finally {
    await agentRegistry?.close();
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
  const label = `${invocation.runId}/${invocation.nodeId}`;
  try {
    store = await openPersistentStore(invocation.store);
    const run = await store.getRun(invocation.runId);
    if (run === undefined) {
      throw new Error(`unknown run: "${invocation.runId}"`);
    }
    if (run.graph.nodes[invocation.nodeId] === undefined) {
      throw new Error(
        `unknown node "${invocation.nodeId}" in run "${invocation.runId}"`,
      );
    }
    const includeDownstream = invocation.command === "rerun-node";

    if (
      store.enqueueAdminRequest === undefined ||
      store.getAdminRequest === undefined
    ) {
      // A store without the admin queue: the historical offline reset.
      await resetRun(
        store,
        invocation.runId,
        [invocation.nodeId],
        includeDownstream ? { includeDownstream: true } : {},
      );
      return reportReset(
        invocation,
        io,
        label,
        "offline",
        undefined,
        undefined,
      );
    }

    const request = await waitForAdminRequest(
      store,
      await store.enqueueAdminRequest({
        requestId: `admin-${randomUUID()}`,
        runId: invocation.runId,
        action: invocation.command,
        nodeId: invocation.nodeId,
      }),
      invocation.timeoutMs,
    );
    if (request.status === "applied") {
      return reportReset(
        invocation,
        io,
        label,
        request.resolvedBy ?? "offline",
        request.resetNodeIds,
        request.requestId,
      );
    }
    io.stderr(
      `cannot ${invocation.command} "${label}": ${request.message ?? request.status}`,
    );
    return EXIT_USAGE;
  } catch (error: unknown) {
    io.stderr(
      `cannot ${invocation.command} "${label}": ${describeError(error)}`,
    );
    return EXIT_USAGE;
  } finally {
    await store?.close?.();
  }
}

/**
 * Drive a queued admin request to a resolution. While a coordinator holds
 * the run, wait for it to apply (or reject) the request. When none does —
 * the run finished, was abandoned, or its coordinator ended mid-wait — apply
 * it offline under the administrative lease. If a live coordinator never
 * acknowledges within the timeout (for example, a coordinator running an
 * older prism that cannot read the queue), withdraw the request so it can
 * never fire later by surprise.
 */
async function waitForAdminRequest(
  store: RunStore,
  queued: AdminRequest,
  timeoutMs: number,
): Promise<AdminRequest> {
  const getRequest = store.getAdminRequest?.bind(store);
  if (getRequest === undefined) {
    throw new Error("this run store does not support admin requests");
  }
  const clock = createSystemClock();
  const deadline = clock.now() + timeoutMs;
  let request = queued;
  while (true) {
    request = (await getRequest(request.requestId)) ?? request;
    if (request.status !== "pending") {
      return request;
    }
    const leases = await store.getRunLeases(request.runId);
    if (!leases.some((lease) => lease.kind === "coordinator")) {
      try {
        return (await applyAdminRequestOffline(store, request.requestId))
          .request;
      } catch (error: unknown) {
        // A coordinator started between the lease check and the offline
        // attempt; keep waiting for it instead.
        if (
          !(error instanceof Error) ||
          !error.message.includes("active coordinator lease")
        ) {
          throw error;
        }
      }
    }
    if (clock.now() >= deadline) {
      const withdrawn = await store.cancelAdminRequest?.(
        request.requestId,
        `no live coordinator acknowledged the request within ${String(timeoutMs)}ms`,
      );
      if (withdrawn !== undefined && withdrawn.status !== "cancelled") {
        return withdrawn;
      }
      throw new Error(
        `run "${request.runId}" has an active coordinator that did not apply the request within ${String(timeoutMs)}ms (it may be running an older prism without live admin requests); the request was withdrawn — retry after the run finishes, or with a longer --timeout`,
      );
    }
    await clock.wait(250);
  }
}

function reportReset(
  invocation: NodeTargetInvocation,
  io: CliIo,
  label: string,
  appliedBy: "live" | "offline",
  resetNodeIds: readonly string[] | undefined,
  requestId: string | undefined,
): number {
  const also = (resetNodeIds ?? []).filter((id) => id !== invocation.nodeId);
  io.stderr(
    appliedBy === "live"
      ? `reset ${label} (applied by the live coordinator; it re-runs now)${also.length > 0 ? `; also reset: ${also.join(", ")}` : ""}`
      : `reset ${label} (applied offline; run \`prism resume ${invocation.runId}\` to re-run it)${also.length > 0 ? `; also reset: ${also.join(", ")}` : ""}`,
  );
  if (invocation.json) {
    io.stdout(
      stringifyJson({
        version: 1,
        runId: invocation.runId,
        reset: invocation.nodeId,
        includeDownstream: invocation.command === "rerun-node",
        appliedBy,
        ...(resetNodeIds === undefined ? {} : { resetNodeIds }),
        ...(requestId === undefined ? {} : { requestId }),
      }),
    );
  }
  return EXIT_SUCCESS;
}

async function statusCommand(
  invocation: StatusInvocation,
  io: CliIo,
): Promise<number> {
  let store: RunStore | undefined;
  try {
    store = await openPersistentStore(invocation.store);
    const runs = await store.listRuns();
    const needsInputByRun = new Map<string, readonly FailureDescription[]>();
    for (const run of runs) {
      const inspection = await inspectRun(store, run.runId).catch(
        () => undefined,
      );
      if (inspection === undefined) continue;
      const waiting = describeFailures(inspection).filter(
        (detail) => detail.disposition === "needs_input",
      );
      if (waiting.length > 0) needsInputByRun.set(run.runId, waiting);
    }
    if (invocation.json) {
      io.stdout(
        stringifyJson({
          version: 1,
          runs: runs.map((run) => {
            const waiting = needsInputByRun.get(run.runId);
            return waiting === undefined
              ? run
              : { ...run, needsInput: waiting };
          }),
        }),
      );
    } else {
      for (const run of runs) {
        io.stdout(`${run.runId}\t${run.finished ? "finished" : "running"}`);
        for (const detail of needsInputByRun.get(run.runId) ?? []) {
          io.stdout(
            `  ⏸ needs input ${detail.nodeId}: ${detail.summary}${detail.pullRequestUrl === undefined ? "" : ` · ${detail.pullRequestUrl}`}`,
          );
          io.stdout(`    → ${detail.hint}`);
        }
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
        failureDetails: describeFailures(inspection),
        leases: inspection.leases,
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
  printFailureLines(inspection, io);
}

function describeFailures(
  inspection: RunInspection,
): readonly FailureDescription[] {
  return inspection.failures.map((failure) =>
    describeFailure(failure, {
      runId: inspection.runId,
      finished: inspection.finished,
    }),
  );
}

/**
 * Failures, split for the operator: blockers waiting on them ("needs
 * input", with the PR) apart from failures, each with its next action.
 * `failure <node>: <cause JSON>` lines stay byte-stable for scripts.
 */
function printFailureLines(inspection: RunInspection, io: CliIo): void {
  const details = describeFailures(inspection);
  for (const [index, failure] of inspection.failures.entries()) {
    const detail = details[index];
    if (detail?.disposition === "needs_input") continue;
    io.stdout(`failure ${failure.nodeId}: ${stringifyJson(failure.cause)}`);
    if (detail !== undefined) io.stdout(`  next: ${detail.hint}`);
  }
  for (const detail of details) {
    if (detail.disposition !== "needs_input") continue;
    io.stdout(
      `needs input ${detail.nodeId}: ${detail.summary}${detail.pullRequestUrl === undefined ? "" : ` · ${detail.pullRequestUrl}`}`,
    );
    io.stdout(`  next: ${detail.hint}`);
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
    if (invocation.runId === undefined) {
      const unfinished = (await store.listRuns()).filter(
        (summary) => !summary.finished,
      );
      if (unfinished.length > 1) {
        return await watchManyRuns(
          store,
          unfinished.map((summary) => summary.runId),
          invocation,
          io,
        );
      }
    }
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
        // Poll runs (and any run with accepted proposals) grow while they
        // are watched, so render the current snapshot, not the first one.
        const graph = (await store.getRun(resolvedRunId))?.graph ?? run.graph;
        const dashboard = renderWatchDashboard(graph, inspection, {
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

/**
 * Watch several unfinished runs at once: stacked dashboards with run
 * headers when interactive, otherwise one snapshot per run per tick. Ends
 * when every watched run has finished; exits 1 if any did not succeed.
 */
async function watchManyRuns(
  store: RunStore,
  runIds: readonly string[],
  invocation: WatchInvocation,
  io: CliIo,
): Promise<number> {
  const clock = createSystemClock();
  let frame = 0;
  while (true) {
    const inspections: RunInspection[] = [];
    for (const runId of runIds) {
      inspections.push(await inspectRun(store, runId));
    }
    if (io.interactive === true && !invocation.json) {
      const rowsPerRun =
        io.rows === undefined
          ? undefined
          : Math.max(6, Math.floor(io.rows / runIds.length) - 1);
      const panels: string[] = [];
      for (const inspection of inspections) {
        const graph = (await store.getRun(inspection.runId))?.graph;
        if (graph === undefined) continue;
        panels.push(
          `── run ${inspection.runId} ${"─".repeat(
            Math.max(0, (io.columns ?? 100) - inspection.runId.length - 8),
          )}`,
        );
        panels.push(
          renderWatchDashboard(graph, inspection, {
            ...(io.columns === undefined ? {} : { columns: io.columns }),
            ...(rowsPerRun === undefined ? {} : { rows: rowsPerRun }),
            ...(io.color === undefined ? {} : { color: io.color }),
            frame,
          }),
        );
      }
      const screen = `\u001B[2J\u001B[H${panels.join("\n")}\n`;
      if (io.write === undefined) {
        io.stdout(screen);
      } else {
        io.write(screen);
      }
    } else {
      for (const inspection of inspections) {
        printWatchSnapshot(inspection, invocation.json, io);
      }
    }
    if (inspections.every((inspection) => inspection.finished)) {
      return inspections.some(inspectionFailed)
        ? EXIT_RUN_FAILED
        : EXIT_SUCCESS;
    }
    frame += 1;
    await clock.wait(invocation.intervalMs);
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

    case "poll":
      return pollCommand(invocation, io);

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
