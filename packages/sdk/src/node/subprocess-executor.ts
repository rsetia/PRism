import type { JsonValue } from "../graph/types.js";
import { isJsonValue } from "../internal/json.js";
import { createSystemClock } from "../adapters/clock.js";
import { normalizeThrownCause } from "../runtime/failures.js";
import type {
  Clock,
  ExecutionContext,
  ExecutorDefinition,
  NodeExecutionOutcome,
} from "../runtime/ports.js";
import type { ExecutionBackend, WorkerHandle } from "./execution-backend.js";
import { isProgressReportingExecutionBackend } from "./execution-backend.js";
import { assessAgentProgress, type StallPolicy } from "./agent-progress.js";
import type {
  WorkspaceHandle,
  WorkspaceProvisioner,
} from "./workspace-provisioner.js";
import type { WorkerResult, WorkerSpec } from "./worker-protocol.js";

export interface SubprocessExecutorOptions {
  /** Registry name this executor answers to. */
  readonly name: string;
  /** How workers are launched and supervised. */
  readonly backend: ExecutionBackend;
  /** Optional isolated workspace per attempt (e.g. a git worktree). */
  readonly provisioner?: WorkspaceProvisioner;
  /** Time source for the poll loop; defaults to the system clock. */
  readonly clock?: Clock;
  /** Idle-heartbeat timeout before a worker is killed. Default 60000ms. */
  readonly idleTimeoutMs?: number;
  /** How often to poll status and liveness. Default 250ms. */
  readonly pollIntervalMs?: number;
  /** Structured-session stall policy. Compatibility backends remain explicitly unobservable. */
  readonly stallPolicy?: StallPolicy;
  /**
   * Turn the node's ordered upstream outputs into the worker's serialized
   * input (this is the §13 shapeInput seam, load-bearing now that inputs
   * cross a process boundary). Default: [] -> null, one -> that value,
   * many -> the array. Must return JSON-safe data.
   */
  readonly shapeInput?: (context: ExecutionContext) => JsonValue;
}

/**
 * Bridge an ExecutionBackend into an ExecutorDefinition (plan §14 slice
 * 2): run each node as a supervised worker process, mapping its result
 * back into the engine's outcome model. Retry, cancellation, and
 * blocking all keep working unchanged — this is "just another executor".
 */
export function createSubprocessExecutor(
  options: SubprocessExecutorOptions,
): ExecutorDefinition {
  if (options.name.length === 0) {
    throw new Error("subprocess executor name must not be empty");
  }

  const clock = options.clock ?? createSystemClock();
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  validateDuration("idleTimeoutMs", idleTimeoutMs);
  validateDuration("pollIntervalMs", pollIntervalMs);
  if (options.stallPolicy !== undefined) {
    // Validate eagerly, before a graph can start, with a harmless snapshot.
    assessAgentProgress(
      {
        capability: "structured",
        processLivenessAtMs: null,
        lastModelEventAtMs: null,
        lastToolEventAtMs: null,
        lastWorkspaceMutationAtMs: null,
        lastPhaseTransitionAtMs: null,
        externalWait: null,
        decisions: [],
      },
      0,
      options.stallPolicy,
    );
  }

  const shapeInput =
    options.shapeInput ??
    ((context: ExecutionContext): unknown => {
      if (context.inputs.length === 0) {
        return null;
      }
      if (context.inputs.length === 1) {
        return context.inputs[0];
      }
      return context.inputs;
    });

  return Object.freeze({
    name: options.name,
    async execute(context: ExecutionContext): Promise<NodeExecutionOutcome> {
      let input: unknown;
      try {
        input = shapeInput(context);
      } catch (error: unknown) {
        return {
          status: "failed",
          cause: {
            code: "INPUT_SHAPING_FAILED",
            error: normalizeThrownCause(error),
          },
          failureClass: "validation_failed",
        };
      }

      if (!isJsonValue(input)) {
        return {
          status: "failed",
          cause: { code: "INVALID_WORKER_INPUT" },
          failureClass: "validation_failed",
        };
      }

      const spec: WorkerSpec = {
        runId: context.runId,
        nodeId: context.nodeId,
        kind: context.kind,
        executor: options.name,
        input,
        config: context.config ?? null,
        attempt: context.attempt,
      };

      let workspace: WorkspaceHandle | undefined;
      try {
        if (options.provisioner !== undefined) {
          workspace = await options.provisioner.provision({
            runId: context.runId,
            nodeId: context.nodeId,
            attempt: context.attempt,
          });
        }

        return await supervise(
          options.backend,
          spec,
          context,
          clock,
          idleTimeoutMs,
          pollIntervalMs,
          options.stallPolicy,
          workspace,
        );
      } catch (error: unknown) {
        return infrastructureFailure(error);
      } finally {
        if (workspace !== undefined && options.provisioner !== undefined) {
          await options.provisioner.release(workspace);
        }
      }
    },
  });
}

async function supervise(
  backend: ExecutionBackend,
  spec: WorkerSpec,
  context: ExecutionContext,
  clock: Clock,
  idleTimeoutMs: number,
  pollIntervalMs: number,
  stallPolicy: StallPolicy | undefined,
  workspace: WorkspaceHandle | undefined,
): Promise<NodeExecutionOutcome> {
  let handle: WorkerHandle | undefined;
  let reportedProgress:
    "active" | "waiting" | "stalled" | "unobservable" | undefined;
  const reportProgress = async (
    state: "active" | "waiting" | "stalled" | "unobservable",
  ): Promise<void> => {
    if (reportedProgress !== state) {
      reportedProgress = state;
      await context.reportAgentProgress?.(state);
    }
  };
  try {
    if (context.signal.aborted) {
      return cancellationFailure();
    }

    handle =
      workspace === undefined
        ? await backend.launch(spec)
        : await backend.launch(spec, { cwd: workspace.dir });
    if (!isProgressReportingExecutionBackend(backend)) {
      await reportProgress("unobservable");
    }

    while (true) {
      if (context.signal.aborted) {
        await backend.terminate(handle);
        return cancellationFailure();
      }

      if ((await backend.poll(handle)) === "exited") {
        let result: WorkerResult;
        try {
          result = await backend.collect(handle);
        } catch (error: unknown) {
          return infrastructureFailure(error);
        }
        return workerOutcome(result);
      }

      const liveness = await backend.checkLiveness(handle, {
        idleTimeoutMs,
        now: clock.now(),
      });
      switch (liveness) {
        case "idle":
          await backend.terminate(handle);
          return {
            status: "failed",
            cause: { code: "WORKER_IDLE_TIMEOUT", idleTimeoutMs },
            failureClass: "timeout",
          };
        case "dead":
          await backend.terminate(handle);
          return {
            status: "failed",
            cause: { code: "WORKER_DIED" },
            failureClass: "transient_infra",
          };
        case "alive":
          if (
            stallPolicy !== undefined &&
            isProgressReportingExecutionBackend(backend)
          ) {
            const assessment = assessAgentProgress(
              await backend.readAgentProgress(handle),
              clock.now(),
              stallPolicy,
            );
            await reportProgress(assessment.state);
            if (assessment.decision !== null) {
              await backend.recordStallDecision(handle, assessment.decision);
              if (assessment.decision.action === "restart") {
                await backend.terminate(handle);
                return {
                  status: "failed",
                  cause: stallCause(
                    "AGENT_STALL_RESTART_REQUESTED",
                    assessment.decision,
                  ),
                  failureClass: "transient_infra",
                };
              }
              if (assessment.decision.action === "escalate") {
                return {
                  status: "failed",
                  cause: stallCause("AGENT_STALLED", assessment.decision),
                  failureClass: "manual_review_required",
                };
              }
            }
          }
          try {
            await clock.wait(pollIntervalMs, context.signal);
          } catch (error: unknown) {
            if (!context.signal.aborted) {
              throw error;
            }
          }
          break;
        default: {
          const unhandledLiveness: never = liveness;
          throw new Error(
            `Unknown worker liveness: ${String(unhandledLiveness)}`,
          );
        }
      }
    }
  } catch (error: unknown) {
    if (handle !== undefined) {
      try {
        await backend.terminate(handle);
      } catch {
        // The original backend error best explains the failed attempt.
      }
    }
    return infrastructureFailure(error);
  }
}

function stallCause(
  code: string,
  decision: {
    readonly action: string;
    readonly atMs: number;
    readonly attempt: number;
  },
): JsonValue {
  return {
    code,
    decision: {
      action: decision.action,
      atMs: decision.atMs,
      attempt: decision.attempt,
    },
  };
}

function workerOutcome(result: WorkerResult): NodeExecutionOutcome {
  if (result.status === "succeeded") {
    return { status: "succeeded", output: result.output };
  }
  return result.failureClass === undefined
    ? { status: "failed", cause: result.error ?? "worker failed" }
    : {
        status: "failed",
        cause: result.error ?? "worker failed",
        failureClass: result.failureClass,
      };
}

function cancellationFailure(): NodeExecutionOutcome {
  return {
    status: "failed",
    cause: { code: "WORKER_CANCELLED" },
    failureClass: "transient_infra",
  };
}

function infrastructureFailure(error: unknown): NodeExecutionOutcome {
  return {
    status: "failed",
    cause: normalizeThrownCause(error),
    failureClass: "transient_infra",
  };
}

function validateDuration(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
}
