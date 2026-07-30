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
  PersistedRunEvent,
  LogBackend,
  RunInspection,
  RunOutcome,
  RunStore,
} from "@rsetia/prism";
import { createFileLogBackend, createSqliteStore } from "@rsetia/prism/node";
import { createAgentExecutorRegistry } from "./agent-executors.js";
import { generateBeadsDag } from "./beads-dag.js";
import {
  missingPrismHomeMessage,
  resolvePrismProjectPaths,
} from "./prism-home.js";
import { renderWatchDashboard } from "./watch-renderer.js";

/** Non-TTY stdout is data; interactive watch may redraw a human dashboard. */
export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly write?: (text: string) => void;
  readonly interactive?: boolean;
  readonly columns?: number;
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

Commands:
  validate <file>                     Check a graph file; exit 0 if valid
  graph <file> [--json]               Print the compiled plan
  beads-dag --out <file> [--repo <path>] [--beads-repo <path>]
                                      Snapshot Beads into an agent DAG
  run <file> [--json] [--store <db>] [--run-id <id>] [--repo <path>]
             [--max-concurrency <n>] [--codex-bin <path>] [--codex-model <id>]
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
  Maximum concurrency                   ${String(DEFAULT_MAX_CONCURRENCY)}`;

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
  readonly agent: AgentInvocationOptions;
}
interface BeadsDagInvocation {
  readonly command: "beads-dag";
  readonly repo: string | undefined;
  readonly beadsRepo: string | undefined;
  readonly out: string;
  readonly bdCommand: string;
  readonly ids: readonly string[];
  readonly statuses: ReadonlySet<string> | null;
  readonly labels: readonly string[];
  readonly targetBranch: string;
  readonly branchPrefix: string;
  readonly validationCommands: readonly string[];
  readonly mergeValidationCommands: readonly string[];
  readonly maxIterations: number;
  readonly reviewer: "greptile" | "claude" | "none";
  readonly minConfidenceScore: number;
  readonly requireNoActionableFindings: boolean;
  readonly requireGreenChecks: boolean;
  readonly reviewTriggerComment: string | undefined;
  readonly includeMerge: boolean;
  readonly includeBeadsUpdate: boolean;
  readonly serializeMerges: boolean;
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
  | NodeTargetInvocation;

interface AgentInvocationOptions {
  readonly repo: string | undefined;
  readonly maxConcurrency: number;
  readonly codexCommand: string | undefined;
  readonly codexModel: string | undefined;
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
  readonly worktreeDir: string | undefined;
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
  let worktreeDir: string | undefined;

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
      arg === "--worktree-dir"
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
      } else {
        if (worktreeDir !== undefined) return undefined;
        worktreeDir = value;
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
    worktreeDir,
  };
}

function parseInvocation(argv: readonly string[]): Invocation | undefined {
  const [command, ...rest] = argv;
  if (command === "beads-dag") {
    return parseBeadsDagInvocation(rest);
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
        flags.interval !== undefined
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
    flags.worktreeDir === undefined
  );
}

function noWorkerFlags(flags: ParsedFlags): boolean {
  return (
    flags.maxConcurrency === undefined &&
    flags.codexCommand === undefined &&
    flags.codexModel === undefined &&
    flags.worktreeDir === undefined
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
    worktreeDir: flags.worktreeDir,
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
    "--target-branch",
    "--branch-prefix",
    "--max-iterations",
    "--reviewer",
    "--min-confidence-score",
    "--review-trigger-comment",
    "--greptile-trigger-comment",
  ]);
  const repeatedFlags = new Set([
    "--id",
    "--status",
    "--label",
    "--validation-command",
    "--merge-validation-command",
  ]);
  const switchFlags = new Set([
    "--all-statuses",
    "--allow-actionable-findings",
    "--skip-green-checks",
    "--no-merge-nodes",
    "--no-beads-update",
    "--no-serialize-merges",
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
  const maxIterations = Number(scalar.get("--max-iterations") ?? "8");
  const minConfidenceScore = Number(
    scalar.get("--min-confidence-score") ?? "5",
  );
  if (
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 1 ||
    !Number.isSafeInteger(minConfidenceScore) ||
    minConfidenceScore < 1 ||
    minConfidenceScore > 5
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

  return {
    command: "beads-dag",
    repo: scalar.get("--repo"),
    beadsRepo: scalar.get("--beads-repo"),
    out,
    bdCommand: scalar.get("--bd-bin") ?? "bd",
    ids: csvValues(repeated.get("--id") ?? []),
    statuses,
    labels: csvValues(repeated.get("--label") ?? []),
    targetBranch: scalar.get("--target-branch") ?? "main",
    branchPrefix: scalar.get("--branch-prefix") ?? "prism/",
    validationCommands: repeated.get("--validation-command") ?? [],
    mergeValidationCommands: repeated.get("--merge-validation-command") ?? [],
    maxIterations,
    reviewer,
    minConfidenceScore,
    requireNoActionableFindings: !switches.has("--allow-actionable-findings"),
    requireGreenChecks: !switches.has("--skip-green-checks"),
    reviewTriggerComment:
      scalar.get("--review-trigger-comment") ??
      scalar.get("--greptile-trigger-comment"),
    includeMerge: !switches.has("--no-merge-nodes"),
    includeBeadsUpdate: !switches.has("--no-beads-update"),
    serializeMerges: !switches.has("--no-serialize-merges"),
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
  let hasDefaultStore: boolean;
  try {
    hasDefaultStore =
      resolvePrismProjectPaths(invocation.agent.repo).storePath !== undefined;
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
      }),
      maxConcurrency: invocation.agent.maxConcurrency,
    });
    const runId =
      invocation.runId ?? (durable ? `run-${randomUUID()}` : undefined);
    const handle = engine.run(graph, runId === undefined ? {} : { runId });
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
        }),
      );
    } else {
      for (const node of inspection.nodes) {
        io.stdout(`${node.nodeId}: ${node.state}`);
      }
      for (const failure of inspection.failures) {
        io.stdout(`failure ${failure.nodeId}: ${stringifyJson(failure.cause)}`);
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
  const targets: { readonly nodeId: string; readonly attempt: number }[] = [];
  for (const event of events) {
    if (event.kind === "node_started") {
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
  while (true) {
    const run = await store.getRun(runId);
    if (run === undefined) {
      throw new Error(`unknown run: "${runId}"`);
    }
    const entries = await collectWorkerLogs(store, logBackend, runId);
    for (const entry of entries) {
      const key = workerLogKey(entry);
      const previousLength = emittedLengths.get(key) ?? 0;
      const offset = previousLength <= entry.text.length ? previousLength : 0;
      const chunk = entry.text.slice(offset);
      if (chunk.length > 0) {
        printWorkerLogChunk(entry, chunk, offset === 0, io);
        emittedAny = true;
      }
      emittedLengths.set(key, entry.text.length);
    }
    if (run.finished) {
      if (!emittedAny) {
        io.stderr(`no worker logs for run "${runId}"`);
      }
      return;
    }
    await createSystemClock().wait(500);
  }
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
    case "beads-dag":
      try {
        await generateBeadsDag({
          repoDir: invocation.repo ?? process.cwd(),
          ...(invocation.beadsRepo === undefined
            ? {}
            : { beadsRepoDir: invocation.beadsRepo }),
          outFile: invocation.out,
          bdCommand: invocation.bdCommand,
          ids: invocation.ids,
          statuses: invocation.statuses,
          labels: invocation.labels,
          targetBranch: invocation.targetBranch,
          branchPrefix: invocation.branchPrefix,
          validationCommands: invocation.validationCommands,
          mergeValidationCommands: invocation.mergeValidationCommands,
          maxIterations: invocation.maxIterations,
          reviewer: invocation.reviewer,
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
