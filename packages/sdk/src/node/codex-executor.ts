import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonValue } from "../graph/types.js";
import { isJsonValue } from "../internal/json.js";
import { normalizeThrownCause } from "../runtime/failures.js";
import { parseProofOfWork } from "../runtime/proof-of-work.js";
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
import type { WorkerResult } from "./worker-protocol.js";
import type { NodePhase } from "../runtime/events.js";
import type {
  WorkspaceHandle,
  WorkspaceProvisioner,
} from "./workspace-provisioner.js";
import { WORKER_SPEC_FILE, type WorkerSpec } from "./worker-protocol.js";
import {
  describeReconciledState,
  type NodeReconciler,
  type ReconcileOutcome,
  type ReconciledState,
} from "./reconcile.js";

/**
 * How a worker-declared failure is adjudicated against external state.
 * Only meaningful when a reconciler is configured.
 */
export interface FailureAdjudicationOptions {
  /** Interval between reconciliations while a review or CI is in progress. Default 60 s. */
  readonly pollMs?: number;
  /** Ceiling on waiting for an in-progress review or CI. Default 30 min. */
  readonly maxWaitMs?: number;
  /** Abortable sleep; injected by tests. Default setTimeout. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

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
  /**
   * Inspects the node's external state (branch, pull request, CI, review)
   * before every agent session so a retry, resume, or reset continues from
   * what actually exists. A `satisfied` outcome completes the node without
   * an agent session; a `resume` outcome is appended to the contract.
   * Absent means the agent discovers the state itself, as before.
   */
  readonly reconciler?: NodeReconciler;
  /**
   * When a worker reports a failure, reconcile before accepting it. A pull
   * request that is still open, with iteration budget remaining, means the
   * worker is re-invoked with the current findings; a review or CI still in
   * progress is waited on deterministically here instead of inside an agent
   * session. Requires `reconciler`. Absent means worker failures are final.
   */
  readonly adjudication?: FailureAdjudicationOptions;
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
 * 6. result = await engine.execute(...) for the compatibility backend, or
 *    runAgentSession(...) for a structured session backend. The latter starts
 *    or resumes the durable {runId,nodeId,attempt} conversation.
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
  if (
    options.adjudication?.pollMs !== undefined &&
    (!Number.isFinite(options.adjudication.pollMs) ||
      options.adjudication.pollMs < 1)
  ) {
    throw new Error("adjudication.pollMs must be finite and at least 1 ms");
  }
  if (
    options.adjudication?.maxWaitMs !== undefined &&
    (!Number.isFinite(options.adjudication.maxWaitMs) ||
      options.adjudication.maxWaitMs < 0)
  ) {
    throw new Error("adjudication.maxWaitMs must be finite and non-negative");
  }
  validateExecutorName(options.name);
  const engine = options.engine;
  const sessionBackend = options.sessionBackend;
  if (engine === undefined && sessionBackend === undefined) {
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
      const contract = buildContract({
        runId: "preflight",
        nodeId: "preflight",
        kind: "task",
        executor: name,
        input: null,
        config: config ?? null,
        attempt: 1,
      });
      engine?.validateContract?.(contract);
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
      const nodeDirs: string[] = [];
      let logWriter: LogWriter | undefined;
      let pendingLogWrites = Promise.resolve();
      let outcome: NodeExecutionOutcome;
      try {
        await context.reportPhase("worktree_setup");
        workspace = await options.provisioner?.provision({
          runId: context.runId,
          nodeId: context.nodeId,
          attempt: context.attempt,
          baseBranch: targetBranchFor(name, spec.config),
        });
        const worktreeDir = resolve(workspace?.dir ?? cwd);
        const nodeDirBase = resolve(explicitNodeDirBase ?? worktreeDir);
        await mkdir(nodeDirBase, { recursive: true });
        let sessionSpec = spec;
        let reinvocations = 0;
        const prepareNodeDir = async (): Promise<string> => {
          const dir = await mkdtemp(
            join(
              nodeDirBase,
              `.prism-${safePathPart(context.runId)}-${safePathPart(context.nodeId)}-a${String(context.attempt)}-`,
            ),
          );
          nodeDirs.push(dir);
          await writeFile(
            join(dir, WORKER_SPEC_FILE),
            JSON.stringify(sessionSpec),
            "utf8",
          );
          return dir;
        };
        logWriter = await options.logBackend?.openWriter({
          runId: context.runId,
          nodeId: context.nodeId,
          attempt: context.attempt,
        });
        const onOutput =
          logWriter === undefined
            ? undefined
            : (chunk: string): void => {
                pendingLogWrites = pendingLogWrites.then(() =>
                  logWriter?.write(chunk),
                );
              };

        const baseContract = contract;
        const reconcile = async (): Promise<ReconcileOutcome | undefined> => {
          if (options.reconciler === undefined) {
            return undefined;
          }
          await context.reportPhase("reconciliation");
          const outcome = await options.reconciler.reconcile({
            spec,
            worktreeDir,
            signal: context.signal,
          });
          onOutput?.(describeReconciliation(outcome));
          return outcome;
        };
        const reconciled = await reconcile();
        if (reconciled?.kind === "resume") {
          contract = withReconciledState(baseContract, reconciled.state);
        }

        const runAgent = async (): Promise<WorkerResult> => {
          const nodeDirPath = await prepareNodeDir();
          await context.reportPhase(codexExecutionPhase(name));
          return sessionBackend === undefined
            ? await engine!.execute({
                spec: sessionSpec,
                nodeDir: nodeDirPath,
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
                    ...(reinvocations === 0
                      ? {}
                      : { reinvocation: reinvocations }),
                  },
                  spec: sessionSpec,
                  nodeDir: nodeDirPath,
                  worktreeDir,
                  sandbox:
                    contract.dangerouslyBypassApprovalsAndSandbox === true
                      ? "danger-full-access"
                      : (contract.sandbox ?? "workspace-write"),
                  prompt: buildCodexPrompt({
                    spec: sessionSpec,
                    nodeDir: nodeDirPath,
                    worktreeDir,
                    contract,
                    specPath: join(nodeDirPath, WORKER_SPEC_FILE),
                    resultPath: join(nodeDirPath, "result.json"),
                    heartbeatPath: join(nodeDirPath, "heartbeat.json"),
                    phasePath: join(nodeDirPath, "phase.json"),
                  }),
                },
                {
                  backend: sessionBackend,
                  ...(options.sessionStore === undefined
                    ? {}
                    : { store: options.sessionStore }),
                  signal: context.signal,
                  ...(onOutput === undefined ? {} : { onOutput }),
                  onPhase: context.reportPhase,
                },
              );
        };
        let result: WorkerResult | AdjudicatedFailure =
          reconciled?.kind === "satisfied"
            ? { status: "succeeded" as const, output: reconciled.output }
            : await runAgent();

        // Adjudicate worker-declared failures against the world instead of
        // trusting the worker's verdict on its own work.
        if (
          options.reconciler !== undefined &&
          options.adjudication !== undefined
        ) {
          const budget = iterationBudget(name, spec.config);
          while (result.status === "failed") {
            const workerFailure = result;
            const verdict = await adjudicateFailure({
              reconcile,
              adjudication: options.adjudication,
              signal: context.signal,
              reportPhase: context.reportPhase,
            });
            onOutput?.(describeAdjudication(verdict, reinvocations, budget));
            if (verdict.kind === "satisfied") {
              result = { status: "succeeded", output: verdict.output };
              break;
            }
            if (verdict.kind === "reinvoke" && reinvocations < budget) {
              reinvocations += 1;
              sessionSpec = {
                ...spec,
                config: { ...toJson(spec.config), maxIterations: 1 },
              };
              contract = withReconciledState(
                buildContract(sessionSpec),
                verdict.state,
                previousFailureNote(workerFailure, budget - reinvocations),
              );
              result = await runAgent();
              continue;
            }
            result = {
              status: "failed",
              error: workerFailure.error,
              ...(workerFailure.failureClass === undefined
                ? {}
                : { failureClass: workerFailure.failureClass }),
              evidence: {
                reason:
                  verdict.kind === "reinvoke"
                    ? `review iteration budget exhausted (${String(budget)})`
                    : verdict.reason,
                reinvocations,
                maxIterations: budget,
                ...(verdict.kind === "terminal" && verdict.state !== undefined
                  ? { state: verdict.state }
                  : {}),
                ...(verdict.kind === "reinvoke"
                  ? { state: verdict.state }
                  : {}),
              },
            } satisfies AdjudicatedFailure;
            break;
          }
        }
        await pendingLogWrites;
        if (result.status === "succeeded") {
          try {
            parseProofOfWork(result.output);
            outcome = { status: "succeeded", output: result.output };
          } catch (error: unknown) {
            outcome = validationFailure("MALFORMED_PROOF_OF_WORK", error);
          }
        } else {
          const evidence = (result as AdjudicatedFailure).evidence;
          outcome = {
            status: "failed",
            cause:
              evidence === undefined
                ? (result.error ?? "codex failed")
                : {
                    code: "WORKER_FAILURE_ADJUDICATED",
                    error: result.error ?? "codex failed",
                    ...toJson(evidence),
                  },
            ...(result.failureClass === undefined
              ? {}
              : { failureClass: result.failureClass }),
          };
        }
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

      if (explicitNodeDirBase === undefined) {
        for (const dir of nodeDirs) {
          await rm(dir, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
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

type AdjudicatedFailure = Extract<WorkerResult, { status: "failed" }> & {
  readonly evidence?: {
    readonly reason: string;
    readonly reinvocations: number;
    readonly maxIterations: number;
    readonly state?: ReconciledState;
  };
};

type AdjudicationVerdict =
  | { readonly kind: "satisfied"; readonly output: JsonValue }
  | { readonly kind: "reinvoke"; readonly state: ReconciledState }
  | {
      readonly kind: "terminal";
      readonly reason: string;
      readonly state?: ReconciledState;
    };

/**
 * Decide what a worker-declared failure means by looking at the pull
 * request rather than the worker's message. While the reviewer or CI is
 * still working on the current head, wait here — an agent session that
 * sleeps is the expensive way to poll.
 */
async function adjudicateFailure(input: {
  readonly reconcile: () => Promise<ReconcileOutcome | undefined>;
  readonly adjudication: FailureAdjudicationOptions;
  readonly signal: AbortSignal;
  readonly reportPhase: (phase: NodePhase) => Promise<void>;
}): Promise<AdjudicationVerdict> {
  const pollMs = input.adjudication.pollMs ?? 60_000;
  const maxWaitMs = input.adjudication.maxWaitMs ?? 30 * 60_000;
  const wait = input.adjudication.wait ?? defaultWait;
  let waited = 0;
  while (true) {
    const outcome = await input.reconcile();
    if (outcome === undefined || outcome.kind === "fresh") {
      return {
        kind: "terminal",
        reason: "no branch or pull request to continue from",
      };
    }
    if (outcome.kind === "satisfied") {
      return { kind: "satisfied", output: outcome.output };
    }
    const state = outcome.state;
    if (state.pullRequest === undefined || state.pullRequest.state !== "open") {
      return {
        kind: "terminal",
        reason:
          state.pullRequest === undefined
            ? "branch exists but no pull request is open"
            : `pull request is ${state.pullRequest.state}`,
        state,
      };
    }
    const reviewInProgress = state.review?.inProgress === true;
    const ciPending = state.ci === "pending";
    if (!reviewInProgress && !ciPending) {
      return { kind: "reinvoke", state };
    }
    if (waited >= maxWaitMs) {
      return {
        kind: "terminal",
        reason: `${reviewInProgress ? "review" : "checks"} still in progress after ${String(Math.round(maxWaitMs / 60_000))} minutes`,
        state,
      };
    }
    await input.reportPhase(reviewInProgress ? "review_wait" : "ci_wait");
    const delay = Math.min(pollMs, maxWaitMs - waited);
    await wait(delay, input.signal);
    waited += delay;
  }
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    if (signal.aborted) {
      rejectWait(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveWait();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectWait(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("adjudication wait aborted");
  error.name = "AbortError";
  return error;
}

function targetBranchFor(
  name: "implement" | "merge_resolve" | "finalize_pr",
  config: JsonValue | null,
): string {
  switch (name) {
    case "implement":
      return parseImplementConfig(config ?? undefined).targetBranch;
    case "merge_resolve":
      return parseMergeResolveConfig(config ?? undefined).targetBranch;
    case "finalize_pr":
      return parseFinalizePrConfig(config ?? undefined).targetBranch;
  }
}

function iterationBudget(
  name: "implement" | "merge_resolve" | "finalize_pr",
  config: JsonValue | null,
): number {
  switch (name) {
    case "implement":
      return parseImplementConfig(config ?? undefined).maxIterations ?? 8;
    case "finalize_pr":
      return parseFinalizePrConfig(config ?? undefined).maxIterations ?? 8;
    case "merge_resolve":
      return 0;
  }
}

function withReconciledState(
  base: CodexExecutorContract,
  state: ReconciledState,
  note?: string,
): CodexExecutorContract {
  const sections = [base.instructions, describeReconciledState(state)];
  if (note !== undefined) {
    sections.push(note);
  }
  return Object.freeze({ ...base, instructions: sections.join("\n\n") });
}

function previousFailureNote(
  failure: Extract<WorkerResult, { status: "failed" }>,
  remaining: number,
): string {
  const classNote =
    failure.failureClass === undefined
      ? ""
      : ` (failureClass ${failure.failureClass})`;
  return `Your previous session in this node ended with a failed result${classNote}: ${JSON.stringify(failure.error)}.
The orchestrator reconciled the pull request afterwards and found it still viable; the current state is above. ${String(remaining)} orchestrator continuation(s) remain after this one.
This session is a single continuation attempt with at most one fix/review iteration, not a fresh full iteration allowance. This limit also overrides any iteration allowance in custom instructions. Continue from the current state: fix the findings, rerun validation, push, and re-request review. Report the outcome after that iteration so the orchestrator can reconcile it and decide whether to continue.`;
}

function describeAdjudication(
  verdict: AdjudicationVerdict,
  reinvocations: number,
  budget: number,
): string {
  const detail =
    verdict.kind === "satisfied"
      ? "pull request already satisfies the gate; overriding the worker's failure"
      : verdict.kind === "reinvoke"
        ? reinvocations < budget
          ? `pull request still viable; re-invoking the worker (${String(reinvocations + 1)}/${String(budget)})`
          : `pull request still viable but the iteration budget (${String(budget)}) is exhausted; failing`
        : `accepting the worker's failure: ${verdict.reason}`;
  return `[prism] adjudication: ${detail}\n`;
}

function toJson(value: unknown): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function describeReconciliation(outcome: ReconcileOutcome): string {
  const notes = outcome.kind === "fresh" ? outcome.notes : outcome.state.notes;
  const detail =
    outcome.kind === "fresh"
      ? "no prior state found; starting fresh"
      : outcome.kind === "satisfied"
        ? "external state already satisfies this node; skipping the agent session"
        : `resuming from existing state on branch ${outcome.state.branch}`;
  const noteLines = notes.map((note) => `  - ${note}`).join("\n");
  return `[prism] reconciliation: ${detail}${noteLines.length === 0 ? "" : `\n${noteLines}`}\n`;
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
