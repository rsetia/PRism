/**
 * The whole CLI, isolated from process wiring so exit codes and output
 * are testable. Only `main.ts` touches `process`.
 *
 * A CLI is an API (plan §6): stdout carries machine-readable data and
 * NOTHING else — it gets piped. Every human-facing diagnostic goes to
 * stderr. Exit codes are the interface for shell scripts.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  parseGraph,
} from "@rsetia/agent-graph";
import type {
  CompiledGraph,
  GraphCompileError,
  GraphParseError,
  NodeFailure,
} from "@rsetia/agent-graph";

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

export const USAGE = `Usage: agent-graph <command> [options]

Commands:
  validate <file>        Check a graph file; exit 0 if valid
  graph <file> [--json]  Print the compiled plan
  run <file> [--json]    Execute the graph with the built-in executors`;

type Command = "validate" | "graph" | "run";

interface Invocation {
  readonly command: Command;
  readonly file: string;
  readonly json: boolean;
}

function parseInvocation(argv: readonly string[]): Invocation | undefined {
  const [command, file, ...rest] = argv;
  if (command !== "validate" && command !== "graph" && command !== "run") {
    return undefined;
  }
  if (file === undefined || file.startsWith("--")) {
    return undefined;
  }

  if (command === "validate") {
    return rest.length === 0 ? { command, file, json: false } : undefined;
  }

  if (rest.length === 0) {
    return { command, file, json: false };
  }
  if (rest.length === 1 && rest[0] === "--json") {
    return { command, file, json: true };
  }
  return undefined;
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
  json: boolean,
  io: CliIo,
): Promise<number> {
  const engine = createEngine({
    store: createMemoryStore(),
    registry: createExecutorRegistry(builtinExecutors),
  });
  const outcome = await engine.run(graph).result;

  if (outcome.status === "succeeded") {
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
  }

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
}

/**
 * Implement per the decided spec below. Import ONLY
 * from "@rsetia/agent-graph" (the public entry point) — never from SDK
 * source paths.
 *
 * Dispatch:
 * - No command, unknown command, missing <file>, or an unrecognized
 *   flag -> USAGE to stderr, return EXIT_USAGE.
 * - Read the file; unreadable file or malformed JSON -> one stderr
 *   diagnostic, EXIT_USAGE.
 * - parseGraph/compileGraph errors -> one stderr line per error in the
 *   form `error <CODE> <json-of-other-fields>`, EXIT_USAGE.
 *
 * validate <file>:
 * - Valid -> nothing on stdout (a human note on stderr is fine),
 *   EXIT_SUCCESS.
 *
 * graph <file> (text; this IS data, so it goes to stdout, exactly):
 *   <id> (<executor>)            for each node in compiled order,
 *   <id> (<executor>) <- a, b    with deps listed in dependsOn order,
 *   final: <finalNode>           last line.
 *
 * graph <file> --json (one line to stdout):
 *   {"version":1,"order":[...],"finalNode":"...","nodes":{id:{executor,
 *   dependsOn,dependents}}}
 *
 * run <file>:
 * - Engine = createEngine({ store: createMemoryStore(), registry:
 *   createExecutorRegistry(builtinExecutors) }).
 * - Success: JSON.stringify(output) to stdout, EXIT_SUCCESS.
 * - Failure: nothing on stdout; per-failure stderr diagnostics
 *   (mention the nodeId), EXIT_RUN_FAILED.
 *
 * run <file> --json (one line to stdout, versioned, no decoration):
 * - {"version":1,"status":"succeeded","output":...} -> EXIT_SUCCESS
 * - {"version":1,"status":"failed","failures":[...]} -> EXIT_RUN_FAILED
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

  const graph = await loadGraph(invocation.file, io);
  if (graph === undefined) {
    return EXIT_USAGE;
  }

  switch (invocation.command) {
    case "validate":
      return EXIT_SUCCESS;

    case "graph":
      if (invocation.json) {
        printJsonGraph(graph, io);
      } else {
        printTextGraph(graph, io);
      }
      return EXIT_SUCCESS;

    case "run":
      return runGraph(graph, invocation.json, io);

    default: {
      const unhandledCommand: never = invocation.command;
      throw new Error(`unhandled command: ${String(unhandledCommand)}`);
    }
  }
}
