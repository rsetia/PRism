import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonValue } from "../graph/types.js";
import { isJsonValue } from "../internal/json.js";
import { normalizeThrownCause } from "../runtime/failures.js";
import type {
  ExecutionContext,
  ExecutorDefinition,
  LogBackend,
  LogWriter,
  NodeExecutionOutcome,
} from "../runtime/ports.js";
import {
  buildCodexPrompt,
  type CodexEngine,
  type CodexExecutorContract,
} from "./codex-engine.js";
import {
  runAgentSession,
  type AgentSessionBackend,
  type AgentSessionStore,
} from "./agent-session-backend.js";
import {
  codexContractForSpec,
  parseFinalizePrConfig,
  parseImplementConfig,
  parseMergeResolveConfig,
} from "./codex-contracts.js";
import type {
  WorkspaceHandle,
  WorkspaceProvisioner,
} from "./workspace-provisioner.js";
import { WORKER_SPEC_FILE, type WorkerSpec } from "./worker-protocol.js";

/**
 * Bridge the codex engine into an ExecutorDefinition (plan §15, final
 * piece): the executor that makes `implement` and `merge_resolve` nodes
 * runnable through the graph engine.
 *
 * Unlike the generic subprocess executor, a codex node does NOT go through
 * the ExecutionBackend/worker-protocol layer — the codex engine already
 * spawns and supervises the `codex` child itself. This factory just:
 * shapes the spec, picks the contract, provisions a worktree, hands both
 * to the engine, and maps the WorkerResult back into a node outcome.
 * Because the engine is injected, tests drive it with a fake — no live
 * `codex` binary required.
 */

export interface CodexExecutorOptions {
  /** Registry name — "implement" or "merge_resolve". */
  readonly name: string;
  /** The codex engine (real via createCodexEngine, or a test fake). */
  readonly engine?: CodexEngine;
  /** Structured, resumable alternative to the compatibility Codex engine. */
  readonly sessionBackend?: AgentSessionBackend;
  /** Optional durable store; defaults to agent-session.json in the node dir. */
  readonly sessionStore?: AgentSessionStore;
  /** Provisions the worktree codex runs in (a git worktree in practice). */
  readonly provisioner?: WorkspaceProvisioner;
  /** Working dir when no provisioner is set. Default process.cwd(). */
  readonly cwd?: string;
  /**
   * Parent dir for the per-run node dir. Default: inside the worktree.
   * Explicit directories retain protocol files for audit/debugging;
   * default in-worktree directories are removed after execution.
   */
  readonly nodeDirBase?: string;
  /** Durable destination for combined Codex stdout/stderr. */
  readonly logBackend?: LogBackend;
  /**
   * Turn ordered upstream outputs into the worker's serialized input.
   * Default: [] -> null, one -> that value, many -> the array. JSON-safe.
   */
  readonly shapeInput?: (context: ExecutionContext) => JsonValue;
  /**
   * Override contract selection. Default: codexContractForSpec, which also
   * validates the node config for the executor name.
   */
  readonly buildContract?: (spec: WorkerSpec) => CodexExecutorContract;
}

/**
 * createCodexExecutor:
 *
 * validateConfig: dispatch on options.name to parseImplementConfig /
 * parseMergeResolveConfig so a misconfigured node fails at preflight,
 * before any worktree or codex process. An unknown name is an error.
 *
 * execute(context):
 * 1. input = shapeInput(context); if not JSON-safe -> failed
 *    { failureClass: "validation_failed" }.
 * 2. spec: WorkerSpec = { runId, nodeId, kind, executor: options.name,
 *    input, config: context.config ?? null, attempt } from context.
 * 3. contract = buildContract(spec) (default codexContractForSpec). A
 *    config error thrown here -> failed { failureClass: "validation_failed" }.
 * 4. workspace = provisioner ? await provision({ runId, nodeId, attempt })
 *    : undefined. worktreeDir = workspace?.dir ?? cwd ?? process.cwd().
 * 5. nodeDir = mkdtemp under nodeDirBase ?? worktreeDir; write spec.json
 *    (the codex engine reads its protocol files there).
 * 6. result = await engine.execute({ spec, nodeDir, worktreeDir, contract,
 *    signal: context.signal }).
 * 7. map: succeeded -> { status: "succeeded", output: result.output };
 *    failed -> { status: "failed", cause: result.error ?? "codex failed",
 *    failureClass: result.failureClass }. A thrown engine error ->
 *    failed { failureClass: "transient_infra" } (never let it reject the
 *    node — failures are data).
 * 8. finally: release the workspace (idempotent; the provisioner tolerates
 *    a double release). Best-effort clean the node dir.
 */
export function createCodexExecutor(
  options: CodexExecutorOptions,
): ExecutorDefinition {
  validateExecutorName(options.name);
  if (options.engine === undefined && options.sessionBackend === undefined) {
    throw new Error("Codex executor requires an engine or sessionBackend");
  }
  const name = options.name;
  const cwd = optionalDirectory(options.cwd, "cwd") ?? process.cwd();
  const explicitNodeDirBase = optionalDirectory(
    options.nodeDirBase,
    "nodeDirBase",
  );
  const shapeInput = options.shapeInput ?? defaultShapeInput;
  const buildContract = options.buildContract ?? codexContractForSpec;

  return Object.freeze({
    name,
    validateConfig(config: JsonValue | undefined): void {
      validateCodexConfig(name, config);
    },
    async execute(context: ExecutionContext): Promise<NodeExecutionOutcome> {
      let input: unknown;
      try {
        input = shapeInput(context);
      } catch (error: unknown) {
        return validationFailure("INPUT_SHAPING_FAILED", error);
      }
      if (!isJsonValue(input)) {
        return {
          status: "failed",
          cause: {
            code: "INVALID_CODEX_INPUT",
            message: "shapeInput must return a JSON-safe value",
          },
          failureClass: "validation_failed",
        };
      }

      const spec: WorkerSpec = Object.freeze({
        runId: context.runId,
        nodeId: context.nodeId,
        kind: context.kind,
        executor: name,
        input,
        config: context.config ?? null,
        attempt: context.attempt,
      });

      let contract: CodexExecutorContract;
      try {
        contract = buildContract(spec);
      } catch (error: unknown) {
        return validationFailure("INVALID_CODEX_CONTRACT_CONFIG", error);
      }

      let workspace: WorkspaceHandle | undefined;
      let nodeDir: string | undefined;
      let logWriter: LogWriter | undefined;
      let pendingLogWrites = Promise.resolve();
      let outcome: NodeExecutionOutcome;
      try {
        await context.reportPhase("worktree_setup");
        workspace = await options.provisioner?.provision({
          runId: context.runId,
          nodeId: context.nodeId,
          attempt: context.attempt,
        });
        const worktreeDir = resolve(workspace?.dir ?? cwd);
        const nodeDirBase = resolve(explicitNodeDirBase ?? worktreeDir);
        await mkdir(nodeDirBase, { recursive: true });
        nodeDir = await mkdtemp(
          join(
            nodeDirBase,
            `.prism-${safePathPart(context.runId)}-${safePathPart(context.nodeId)}-a${String(context.attempt)}-`,
          ),
        );
        await writeFile(
          join(nodeDir, WORKER_SPEC_FILE),
          JSON.stringify(spec),
          "utf8",
        );
        logWriter = await options.logBackend?.openWriter({
          runId: context.runId,
          nodeId: context.nodeId,
          attempt: context.attempt,
        });

        await context.reportPhase(codexExecutionPhase(name));
        const onOutput =
          logWriter === undefined
            ? undefined
            : (chunk: string): void => {
                pendingLogWrites = pendingLogWrites.then(() =>
                  logWriter?.write(chunk),
                );
              };
        const result =
          options.sessionBackend === undefined
            ? await options.engine!.execute({
                spec,
                nodeDir,
                worktreeDir,
                contract,
                signal: context.signal,
                ...(onOutput === undefined ? {} : { onOutput }),
                onPhase: context.reportPhase,
              })
            : await runAgentSession(
                {
                  key: {
                    runId: context.runId,
                    nodeId: context.nodeId,
                    attempt: context.attempt,
                  },
                  spec,
                  nodeDir,
                  worktreeDir,
                  prompt: buildCodexPrompt({
                    spec,
                    nodeDir,
                    worktreeDir,
                    contract,
                    specPath: join(nodeDir, WORKER_SPEC_FILE),
                    resultPath: join(nodeDir, "result.json"),
                    heartbeatPath: join(nodeDir, "heartbeat.json"),
                    phasePath: join(nodeDir, "phase.json"),
                  }),
                },
                {
                  backend: options.sessionBackend,
                  ...(options.sessionStore === undefined
                    ? {}
                    : { store: options.sessionStore }),
                  signal: context.signal,
                  ...(onOutput === undefined ? {} : { onOutput }),
                  onPhase: context.reportPhase,
                },
              );
        await pendingLogWrites;
        outcome =
          result.status === "succeeded"
            ? { status: "succeeded", output: result.output }
            : {
                status: "failed",
                cause: result.error ?? "codex failed",
                ...(result.failureClass === undefined
                  ? {}
                  : { failureClass: result.failureClass }),
              };
      } catch (error: unknown) {
        outcome = infrastructureFailure("CODEX_EXECUTION_FAILED", error);
      }

      if (logWriter !== undefined) {
        let logFailure: unknown;
        try {
          await pendingLogWrites;
        } catch (error: unknown) {
          logFailure = error;
        }
        try {
          await logWriter.close();
        } catch (error: unknown) {
          logFailure ??= error;
        }
        if (logFailure !== undefined) {
          outcome = infrastructureFailure("LOG_PERSISTENCE_FAILED", logFailure);
        }
      }

      try {
        await context.reportPhase("workspace_cleanup");
      } catch (error: unknown) {
        // Never let a timing-observability write overturn completed work: a
        // retry of a succeeded node would re-run an implementation whose PR
        // already landed.
        if (outcome.status !== "succeeded") {
          outcome = infrastructureFailure("PHASE_PERSISTENCE_FAILED", error);
        }
      }

      if (nodeDir !== undefined && explicitNodeDirBase === undefined) {
        await rm(nodeDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }

      if (workspace !== undefined && options.provisioner !== undefined) {
        try {
          await options.provisioner.release(workspace, {
            preserveBranch: outcome.status === "failed",
          });
        } catch (error: unknown) {
          return infrastructureFailure("WORKSPACE_RELEASE_FAILED", error);
        }
      }

      return outcome;
    },
  });
}

function codexExecutionPhase(
  name: "implement" | "merge_resolve" | "finalize_pr",
): "implementation" | "integration_update" | "finalization" {
  switch (name) {
    case "implement":
      return "implementation";
    case "merge_resolve":
      return "integration_update";
    case "finalize_pr":
      return "finalization";
  }
}

function validateExecutorName(
  name: string,
): asserts name is "implement" | "merge_resolve" | "finalize_pr" {
  if (
    name !== "implement" &&
    name !== "merge_resolve" &&
    name !== "finalize_pr"
  ) {
    throw new Error(
      `Codex executor name must be "implement", "merge_resolve", or "finalize_pr"; received ${JSON.stringify(name)}`,
    );
  }
}

function validateCodexConfig(
  name: "implement" | "merge_resolve" | "finalize_pr",
  config: JsonValue | undefined,
): void {
  switch (name) {
    case "implement":
      parseImplementConfig(config);
      return;
    case "merge_resolve":
      parseMergeResolveConfig(config);
      return;
    case "finalize_pr":
      parseFinalizePrConfig(config);
      return;
  }
}

function optionalDirectory(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return resolve(value);
}

function defaultShapeInput(context: ExecutionContext): JsonValue {
  if (context.inputs.length === 0) {
    return null;
  }
  if (context.inputs.length === 1) {
    return context.inputs[0] as JsonValue;
  }
  return context.inputs;
}

function safePathPart(value: string): string {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
  return sanitized.length === 0 ? "_" : sanitized;
}

function validationFailure(code: string, error: unknown): NodeExecutionOutcome {
  return {
    status: "failed",
    cause: { code, error: normalizeThrownCause(error) },
    failureClass: "validation_failed",
  };
}

function infrastructureFailure(
  code: string,
  error: unknown,
): NodeExecutionOutcome {
  return {
    status: "failed",
    cause: { code, error: normalizeThrownCause(error) },
    failureClass: "transient_infra",
  };
}
