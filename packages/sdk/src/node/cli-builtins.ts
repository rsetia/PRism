import type { JsonValue } from "../graph/types.js";
import { isPlainObject } from "../internal/json.js";
import { normalizeThrownCause } from "../runtime/failures.js";
import type {
  ExecutionContext,
  ExecutorDefinition,
  NodeExecutionOutcome,
} from "../runtime/ports.js";
import {
  createExecFileRunner,
  type CommandResult,
  type CommandRunner,
} from "./command-runner.js";

/**
 * The deterministic §15 executors (from PRism-py). Unlike implement /
 * merge_resolve, these do NOT need an agent — they run fixed `gh` / `bd`
 * commands — so they stay builtin: cheaper, testable, no agent variance.
 * They shell out through an injected CommandRunner.
 */

export interface MergePrConfig {
  readonly targetBranch: string;
  /** Feature branch to merge; defaults to the upstream node's branch. */
  readonly sourceBranch?: string;
  readonly mergeMethod?: "squash" | "merge" | "rebase";
  readonly validationCommands?: readonly string[];
}

export interface MergePrExecutorOptions {
  /** Registry name. Default "merge_pr". */
  readonly name?: string;
  /** How commands run; defaults to the real execFile runner. */
  readonly runner?: CommandRunner;
  /** The `gh` executable. Default "gh". */
  readonly gh?: string;
  /** Repository directory to run in. Default process.cwd(). */
  readonly cwd?: string;
}

export interface BeadsUpdateConfig {
  readonly beadId: string;
  /** Directory to run `bd` in; overrides the executor's cwd. */
  readonly beadsRepo?: string;
  readonly status?: string;
}

export interface BeadsUpdateExecutorOptions {
  readonly name?: string;
  readonly runner?: CommandRunner;
  /** The `bd` executable. Default "bd". */
  readonly bd?: string;
  readonly cwd?: string;
}

/**
 * Validate/extract a merge_pr node config (doubles as validateConfig).
 *
 * Require a plain object; targetBranch non-empty string;
 * sourceBranch optional non-empty string; mergeMethod one of
 * squash/merge/rebase (default squash); validationCommands string[] when
 * present. Throw naming the offending field.
 */
export function parseMergePrConfig(
  config: JsonValue | undefined,
): MergePrConfig {
  const value = expectObject(config, "config");
  const targetBranch = expectNonEmptyString(
    value["targetBranch"],
    "config.targetBranch",
  );
  const sourceBranch = optionalNonEmptyString(
    value["sourceBranch"],
    "config.sourceBranch",
  );
  const mergeMethod = parseMergeMethod(value["mergeMethod"]);
  const validationCommands = optionalCommandList(
    value["validationCommands"],
    "config.validationCommands",
  );

  return Object.freeze({
    targetBranch,
    ...(sourceBranch === undefined ? {} : { sourceBranch }),
    mergeMethod,
    ...(validationCommands === undefined ? {} : { validationCommands }),
  });
}

/**
 * Validate/extract a beads_update node config (doubles as validateConfig).
 *
 * Require a plain object; beadId non-empty string; beadsRepo/status
 * optional non-empty strings. Status defaults to "closed".
 */
export function parseBeadsUpdateConfig(
  config: JsonValue | undefined,
): BeadsUpdateConfig {
  const value = expectObject(config, "config");
  const beadId = expectNonEmptyString(value["beadId"], "config.beadId");
  const beadsRepo = optionalNonEmptyString(
    value["beadsRepo"],
    "config.beadsRepo",
  );
  const status =
    value["status"] === undefined
      ? "closed"
      : expectNonEmptyString(value["status"], "config.status");

  return Object.freeze({
    beadId,
    ...(beadsRepo === undefined ? {} : { beadsRepo }),
    status,
  });
}

/**
 * merge_pr: merge a feature branch into the target through a GitHub PR
 * (plan §15, from PRism-py). Never direct-pushes — GitHub performs the
 * merge so the PR closes.
 *
 * execute(context):
 * - parse config; resolve the source branch: config.sourceBranch, else
 *   pull it from the single upstream input (a string, or an object with
 *   `branch` or `metadata.branch`). No branch -> failed
 *   { failureClass: "validation_failed" }.
 * - find the PR: `gh pr list --head <source> --base <target> --json number`;
 *   if none, `gh pr create --head <source> --base <target> --fill`.
 * - run each validationCommand (via the runner, in cwd); any non-zero ->
 *   failed { failureClass: "validation_failed" }.
 * - merge: `gh pr merge <number> --<mergeMethod>`. Success -> succeeded
 *   with output { branch, prNumber, merged: true }. A "not mergeable" /
 *   conflict exit -> failed { failureClass: "merge_conflict" }. Any other
 *   gh failure -> failed { failureClass: "transient_infra" }.
 * - honor context.signal (pass it to every runner call).
 * - validateConfig = parseMergePrConfig.
 */
export function createMergePrExecutor(
  options?: MergePrExecutorOptions,
): ExecutorDefinition {
  const name = executorOption(options?.name, "name", "merge_pr");
  const gh = executorOption(options?.gh, "gh", "gh");
  const cwd = executorCwd(options?.cwd);
  const runner = options?.runner ?? createExecFileRunner();

  return Object.freeze({
    name,
    validateConfig(config: JsonValue | undefined): void {
      parseMergePrConfig(config);
    },
    async execute(context: ExecutionContext): Promise<NodeExecutionOutcome> {
      let config: MergePrConfig;
      try {
        config = parseMergePrConfig(context.config);
      } catch (error: unknown) {
        return failure("INVALID_MERGE_PR_CONFIG", "validation_failed", error);
      }

      const branch = config.sourceBranch ?? sourceBranchFrom(context.inputs);
      if (branch === undefined) {
        return {
          status: "failed",
          cause: {
            code: "SOURCE_BRANCH_NOT_FOUND",
            message:
              "merge_pr requires config.sourceBranch or one upstream branch",
          },
          failureClass: "validation_failed",
        };
      }

      let prNumber: number;
      try {
        const firstLookup = await runGh(
          runner,
          gh,
          [
            "pr",
            "list",
            "--head",
            branch,
            "--base",
            config.targetBranch,
            "--json",
            "number",
          ],
          cwd,
          context.signal,
        );
        if (firstLookup.exitCode !== 0) {
          return commandFailure(
            "GH_PR_LIST_FAILED",
            "transient_infra",
            firstLookup,
          );
        }

        const found = parsePrList(firstLookup.stdout);
        if (found !== undefined) {
          prNumber = found;
        } else {
          const created = await runGh(
            runner,
            gh,
            [
              "pr",
              "create",
              "--head",
              branch,
              "--base",
              config.targetBranch,
              "--fill",
            ],
            cwd,
            context.signal,
          );
          if (created.exitCode !== 0) {
            return commandFailure(
              "GH_PR_CREATE_FAILED",
              "transient_infra",
              created,
            );
          }

          const createdNumber = prNumberFromCreate(created.stdout);
          if (createdNumber !== undefined) {
            prNumber = createdNumber;
          } else {
            const secondLookup = await runGh(
              runner,
              gh,
              [
                "pr",
                "list",
                "--head",
                branch,
                "--base",
                config.targetBranch,
                "--json",
                "number",
              ],
              cwd,
              context.signal,
            );
            if (secondLookup.exitCode !== 0) {
              return commandFailure(
                "GH_PR_LIST_FAILED",
                "transient_infra",
                secondLookup,
              );
            }
            const lookedUpNumber = parsePrList(secondLookup.stdout);
            if (lookedUpNumber === undefined) {
              return {
                status: "failed",
                cause: {
                  code: "GH_CREATED_PR_NOT_FOUND",
                  branch,
                  targetBranch: config.targetBranch,
                },
                failureClass: "transient_infra",
              };
            }
            prNumber = lookedUpNumber;
          }
        }

        for (const commandLine of config.validationCommands ?? []) {
          let command: ParsedCommand;
          try {
            command = parseCommandLine(commandLine);
          } catch (error: unknown) {
            return failure(
              "INVALID_VALIDATION_COMMAND",
              "validation_failed",
              error,
            );
          }
          const validation = await runner.run(command.command, command.args, {
            cwd,
            signal: context.signal,
          });
          if (validation.exitCode !== 0) {
            return commandFailure(
              "VALIDATION_COMMAND_FAILED",
              "validation_failed",
              validation,
              { command: commandLine },
            );
          }
        }

        const merged = await runGh(
          runner,
          gh,
          ["pr", "merge", String(prNumber), `--${config.mergeMethod}`],
          cwd,
          context.signal,
        );
        if (merged.exitCode !== 0) {
          return commandFailure(
            "GH_PR_MERGE_FAILED",
            isMergeConflict(merged) ? "merge_conflict" : "transient_infra",
            merged,
          );
        }
      } catch (error: unknown) {
        return failure("COMMAND_LAUNCH_FAILED", "transient_infra", error);
      }

      return {
        status: "succeeded",
        output: Object.freeze({ branch, prNumber, merged: true }),
      };
    },
  });
}

/**
 * beads_update: mark a Beads issue done after its work merged (plan §15).
 *
 * execute(context):
 * - parse config; run `bd update <beadId>` with the status flag when set
 *   (e.g. `--status <status>`), in config.beadsRepo ?? options.cwd.
 * - exit 0 -> succeeded with output { beadId, status }.
 * - non-zero or launch failure -> failed { failureClass: "transient_infra" }
 *   (a bookkeeping update is safe to retry).
 * - validateConfig = parseBeadsUpdateConfig.
 */
export function createBeadsUpdateExecutor(
  options?: BeadsUpdateExecutorOptions,
): ExecutorDefinition {
  const name = executorOption(options?.name, "name", "beads_update");
  const bd = executorOption(options?.bd, "bd", "bd");
  const defaultCwd = executorCwd(options?.cwd);
  const runner = options?.runner ?? createExecFileRunner();

  return Object.freeze({
    name,
    validateConfig(config: JsonValue | undefined): void {
      parseBeadsUpdateConfig(config);
    },
    async execute(context: ExecutionContext): Promise<NodeExecutionOutcome> {
      let config: BeadsUpdateConfig;
      try {
        config = parseBeadsUpdateConfig(context.config);
      } catch (error: unknown) {
        return failure(
          "INVALID_BEADS_UPDATE_CONFIG",
          "validation_failed",
          error,
        );
      }

      const args = ["update", config.beadId];
      if (config.status !== undefined) {
        args.push("--status", config.status);
      }

      let result: CommandResult;
      try {
        result = await runner.run(bd, args, {
          cwd: config.beadsRepo ?? defaultCwd,
          signal: context.signal,
        });
      } catch (error: unknown) {
        return failure("BD_UPDATE_LAUNCH_FAILED", "transient_infra", error);
      }

      if (result.exitCode !== 0) {
        return commandFailure("BD_UPDATE_FAILED", "transient_infra", result);
      }

      return {
        status: "succeeded",
        output: Object.freeze({
          beadId: config.beadId,
          status: config.status ?? null,
        }),
      };
    },
  });
}

const MERGE_METHODS: ReadonlySet<string> = new Set([
  "squash",
  "merge",
  "rebase",
]);

interface ParsedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${field} must be a plain object`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
): string | undefined {
  return value === undefined ? undefined : expectNonEmptyString(value, field);
}

function parseMergeMethod(value: unknown): "squash" | "merge" | "rebase" {
  if (value === undefined) {
    return "squash";
  }
  if (typeof value !== "string" || !MERGE_METHODS.has(value)) {
    throw new Error(
      'config.mergeMethod must be "squash", "merge", or "rebase"',
    );
  }
  return value as "squash" | "merge" | "rebase";
}

function optionalCommandList(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return Object.freeze(
    value.map((entry, index) => {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new Error(
          `${field}[${String(index)}] must be a non-empty string`,
        );
      }
      return entry;
    }),
  );
}

function executorOption(
  value: string | undefined,
  field: string,
  fallback: string,
): string {
  if (value === undefined) {
    return fallback;
  }
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function executorCwd(value: string | undefined): string {
  if (value !== undefined && value.trim().length === 0) {
    throw new Error("cwd must be a non-empty string");
  }
  return value ?? process.cwd();
}

function sourceBranchFrom(inputs: readonly unknown[]): string | undefined {
  if (inputs.length !== 1) {
    return undefined;
  }
  const input = inputs[0];
  if (typeof input === "string") {
    const branch = input.trim();
    return branch.length === 0 ? undefined : branch;
  }
  if (!isPlainObject(input)) {
    return undefined;
  }

  const branch = input["branch"];
  if (typeof branch === "string" && branch.trim().length > 0) {
    return branch.trim();
  }
  const metadata = input["metadata"];
  if (!isPlainObject(metadata)) {
    return undefined;
  }
  const metadataBranch = metadata["branch"];
  return typeof metadataBranch === "string" && metadataBranch.trim().length > 0
    ? metadataBranch.trim()
    : undefined;
}

function runGh(
  runner: CommandRunner,
  gh: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<CommandResult> {
  return runner.run(gh, args, { cwd, signal });
}

function parsePrList(stdout: string): number | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch (error: unknown) {
    throw new Error("gh pr list returned invalid JSON", { cause: error });
  }
  if (!Array.isArray(value)) {
    throw new Error("gh pr list must return a JSON array");
  }
  if (value.length === 0) {
    return undefined;
  }
  const entries = value as unknown[];
  const first: unknown = entries[0];
  if (
    !isPlainObject(first) ||
    !Number.isInteger(first["number"]) ||
    (first["number"] as number) < 1
  ) {
    throw new Error(
      "gh pr list returned an entry without a positive integer number",
    );
  }
  return first["number"] as number;
}

function prNumberFromCreate(stdout: string): number | undefined {
  const match = /(?:\/pull\/|^)\s*(\d+)\s*\/?\s*$/u.exec(stdout.trim());
  if (match?.[1] === undefined) {
    return undefined;
  }
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function parseCommandLine(commandLine: string): ParsedCommand {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let wordStarted = false;

  for (const character of commandLine) {
    if (escaping) {
      current += character;
      escaping = false;
      wordStarted = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      wordStarted = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      wordStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (wordStarted) {
        words.push(current);
        current = "";
        wordStarted = false;
      }
      continue;
    }
    current += character;
    wordStarted = true;
  }

  if (escaping) {
    throw new Error(
      `validation command has a trailing escape: ${JSON.stringify(commandLine)}`,
    );
  }
  if (quote !== undefined) {
    throw new Error(
      `validation command has an unclosed quote: ${JSON.stringify(commandLine)}`,
    );
  }
  if (wordStarted) {
    words.push(current);
  }
  const command = words[0];
  if (command === undefined || command.length === 0) {
    throw new Error("validation command must name an executable");
  }
  return Object.freeze({
    command,
    args: Object.freeze(words.slice(1)),
  });
}

function isMergeConflict(result: CommandResult): boolean {
  const detail = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    detail.includes("not mergeable") ||
    detail.includes("not in a mergeable state") ||
    detail.includes("merge conflict") ||
    detail.includes("conflicts") ||
    detail.includes("cannot be merged") ||
    detail.includes("cannot merge")
  );
}

function commandFailure(
  code: string,
  failureClass: "transient_infra" | "validation_failed" | "merge_conflict",
  result: CommandResult,
  details: Readonly<Record<string, JsonValue>> = {},
): NodeExecutionOutcome {
  return {
    status: "failed",
    cause: {
      code,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ...details,
    },
    failureClass,
  };
}

function failure(
  code: string,
  failureClass: "transient_infra" | "validation_failed",
  error: unknown,
): NodeExecutionOutcome {
  return {
    status: "failed",
    cause: { code, error: normalizeThrownCause(error) },
    failureClass,
  };
}
