/**
 * The whole CLI, isolated from process wiring so exit codes and output
 * are testable. Only `main.ts` touches `process`.
 *
 * A CLI is an API (plan §6): stdout carries machine-readable data and
 * NOTHING else — it gets piped. Every human-facing diagnostic goes to
 * stderr. Exit codes are the interface for shell scripts.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  abortRun,
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
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
  RunInspection,
  RunOutcome,
  RunStore,
} from "@rsetia/prism";
import { createSqliteStore } from "@rsetia/prism/node";

/** stdout: data only. stderr: humans only. */
export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export const EXIT_SUCCESS = 0;
/** The graph ran and failed — a normal, expected outcome. */
export const EXIT_RUN_FAILED = 1;
/** Invalid input or usage — the caller's mistake. */
export const EXIT_USAGE = 2;
/** Unexpected internal error — our bug. Assigned by main.ts. */
export const EXIT_INTERNAL = 3;

export const USAGE = `Usage: prism <command> [options]

Commands:
  validate <file>                     Check a graph file; exit 0 if valid
  graph <file> [--json]               Print the compiled plan
  run <file> [--json] [--store <db>] [--run-id <id>]
                                      Execute the graph (persists with --store)
  inspect <run-id> --store <db> [--json]
                                      Show a persisted run's node states
  events <run-id> --store <db> [--json]
                                      Show a persisted run's event log
  status --store <db> [--json]        List persisted runs
  watch <run-id> --store <db> [--json] [--interval <ms>]
                                      Poll a run until it finishes
  resume <run-id> --store <db> [--json]
                                      Continue an interrupted run to completion
  abort <run-id> --store <db> [--json]
                                      Force a stuck run to a cancelled, finished state
  signal <run-id> <node-id> --store <db> [--json]
                                      Reset a node so a later resume re-runs it
  rerun-node <run-id> <node-id> --store <db> [--json]
                                      Reset a node and its downstream, then resume`;

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
}
interface ReadInvocation {
  readonly command: "inspect" | "events";
  readonly runId: string;
  readonly json: boolean;
  readonly store: string;
}
interface StatusInvocation {
  readonly command: "status";
  readonly json: boolean;
  readonly store: string;
}
interface WatchInvocation {
  readonly command: "watch";
  readonly runId: string;
  readonly json: boolean;
  readonly store: string;
  readonly intervalMs: number;
}
interface ResumeInvocation {
  readonly command: "resume";
  readonly runId: string;
  readonly json: boolean;
  readonly store: string;
}
interface AbortInvocation {
  readonly command: "abort";
  readonly runId: string;
  readonly json: boolean;
  readonly store: string;
}
interface NodeTargetInvocation {
  readonly command: "signal" | "rerun-node";
  readonly runId: string;
  readonly nodeId: string;
  readonly json: boolean;
  readonly store: string;
}
type Invocation =
  | ValidateInvocation
  | GraphInvocation
  | RunInvocation
  | ReadInvocation
  | StatusInvocation
  | WatchInvocation
  | ResumeInvocation
  | AbortInvocation
  | NodeTargetInvocation;

interface ParsedFlags {
  readonly positionals: readonly string[];
  readonly json: boolean;
  readonly store: string | undefined;
  readonly runId: string | undefined;
  readonly interval: string | undefined;
}

/** Positional args plus known scalar flags; an unknown flag is invalid. */
function parseFlags(rest: readonly string[]): ParsedFlags | undefined {
  const positionals: string[] = [];
  let json = false;
  let store: string | undefined;
  let runId: string | undefined;
  let interval: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      if (json) return undefined;
      json = true;
    } else if (
      arg === "--store" ||
      arg === "--run-id" ||
      arg === "--interval"
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
      } else {
        if (interval !== undefined) return undefined;
        interval = value;
      }
    } else if (arg?.startsWith("--") === true) {
      return undefined;
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }

  return { positionals, json, store, runId, interval };
}

function parseInvocation(argv: readonly string[]): Invocation | undefined {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (flags === undefined) return undefined;

  const [first, second] = flags.positionals;
  const count = flags.positionals.length;
  const noExtras =
    flags.store === undefined &&
    flags.runId === undefined &&
    flags.interval === undefined;

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
        flags.interval !== undefined
      ) {
        return undefined;
      }
      return { command, file: first, json: flags.json };
    case "run":
      if (count !== 1 || first === undefined || flags.interval !== undefined) {
        return undefined;
      }
      return {
        command,
        file: first,
        json: flags.json,
        store: flags.store,
        runId: flags.runId,
      };
    case "inspect":
    case "events":
    case "resume":
      if (
        count !== 1 ||
        first === undefined ||
        flags.store === undefined ||
        flags.runId !== undefined ||
        flags.interval !== undefined
      ) {
        return undefined;
      }
      return {
        command,
        runId: first,
        json: flags.json,
        store: flags.store,
      };
    case "abort":
      if (
        count !== 1 ||
        first === undefined ||
        flags.store === undefined ||
        flags.runId !== undefined ||
        flags.interval !== undefined
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
        flags.store === undefined ||
        flags.runId !== undefined ||
        flags.interval !== undefined
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
        flags.store === undefined ||
        flags.runId !== undefined ||
        flags.interval !== undefined
      ) {
        return undefined;
      }
      return { command, json: flags.json, store: flags.store };
    case "watch": {
      if (
        count !== 1 ||
        first === undefined ||
        flags.store === undefined ||
        flags.runId !== undefined
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
        runId: first,
        json: flags.json,
        store: flags.store,
        intervalMs,
      };
    }
    default:
      return undefined;
  }
}

function describeError(error: unknown): string {
  const description = error instanceof Error ? error.message : String(error);
  return description.replace(/\s+/g, " ").trim();
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
  const store =
    invocation.store === undefined
      ? createMemoryStore()
      : createSqliteStore({ path: invocation.store });
  let outcome: RunOutcome;
  try {
    const engine = createEngine({
      store,
      registry: createExecutorRegistry(builtinExecutors),
    });
    const runId =
      invocation.runId ??
      (invocation.store === undefined ? undefined : `run-${randomUUID()}`);
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

async function inspectCommand(
  invocation: ReadInvocation,
  io: CliIo,
): Promise<number> {
  let store: RunStore | undefined;
  try {
    store = createSqliteStore({ path: invocation.store });
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
    store = createSqliteStore({ path: invocation.store });
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

async function resumeCommand(
  invocation: ResumeInvocation,
  io: CliIo,
): Promise<number> {
  let store: RunStore | undefined;
  try {
    store = createSqliteStore({ path: invocation.store });
    const engine = createEngine({
      store,
      registry: createExecutorRegistry(builtinExecutors),
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
    store = createSqliteStore({ path: invocation.store });
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
    store = createSqliteStore({ path: invocation.store });
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
    store = createSqliteStore({ path: invocation.store });
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
  try {
    store = createSqliteStore({ path: invocation.store });
    let terminal: RunInspection | undefined;
    for await (const inspection of watchRun(store, invocation.runId, {
      clock: createSystemClock(),
      intervalMs: invocation.intervalMs,
    })) {
      printWatchSnapshot(inspection, invocation.json, io);
      terminal = inspection;
    }
    if (terminal === undefined) {
      throw new Error(`watch produced no snapshots for "${invocation.runId}"`);
    }
    return inspectionFailed(terminal) ? EXIT_RUN_FAILED : EXIT_SUCCESS;
  } catch (error: unknown) {
    io.stderr(`cannot watch "${invocation.runId}": ${describeError(error)}`);
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
