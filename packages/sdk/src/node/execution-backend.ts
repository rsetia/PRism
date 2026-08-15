import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkerResult, WorkerSpec } from "./worker-protocol.js";
import type {
  AgentProgressSnapshot,
  AgentStallDecision,
} from "./agent-progress.js";
import {
  NODE_DIR_ENV_VAR,
  parseWorkerResult,
  WORKER_HEARTBEAT_FILE,
  WORKER_RESULT_FILE,
  WORKER_SPEC_FILE,
} from "./worker-protocol.js";
import {
  buildChildEnvironment,
  createSecretRedactor,
  SAFE_AGENT_EXECUTION_POLICY,
  validateAgentExecutionPolicy,
  type AgentExecutionPolicy,
} from "./execution-policy.js";

/**
 * The ExecutionBackend port (plan §14, from PRism-py's ARCHITECTURE.md).
 * It owns a worker's whole lifecycle: launch it, poll its status, judge
 * whether it is still alive, terminate it, and collect its result. The
 * engine's supervision loop (a later §14 slice) drives these; concrete
 * backends — local subprocess now, Kubernetes someday — implement them.
 *
 * Liveness lives here, not in a separate store, because detecting it
 * means talking to the platform that runs the worker: a local backend
 * reads a heartbeat file; a K8s backend queries pod status.
 */

/** Has the process finished, or is it still running? */
export type WorkerStatus = "running" | "exited";

/**
 * `alive` — heartbeating within the window.
 * `idle` — running but its heartbeat is stale past the timeout.
 * `dead` — the process exited without leaving a result.
 */
export type Liveness = "alive" | "idle" | "dead";

/**
 * An opaque reference to a launched worker. Consumers pass it back unchanged;
 * the backend keeps platform handles internally.
 */
export interface WorkerHandle {
  /** Backend-defined opaque identity, unique among its launched workers. */
  readonly id: string;
  readonly runId: string;
  readonly nodeId: string;
  /** Local file-protocol directory, when the backend exposes one. */
  readonly nodeDir?: string;
}

export interface LivenessOptions {
  /** Max age of a heartbeat before the worker is considered idle. */
  readonly idleTimeoutMs: number;
  /** Current time (epoch ms), injected so liveness stays testable. */
  readonly now: number;
}

export interface LaunchOptions {
  /**
   * Working directory for the worker (a provisioned worktree, §14 slice
   * 2). When set, the worker runs here and its protocol files are created
   * inside it; when absent, the worker runs in its own node dir under the
   * backend's baseDir.
   */
  readonly cwd?: string;
}

export interface ExecutionBackend {
  /** Host process or an isolation boundary such as a container/pod. */
  readonly isolation?: "host" | "isolated";
  /** Starts one worker for the supplied execution specification. */
  launch(spec: WorkerSpec, options?: LaunchOptions): Promise<WorkerHandle>;
  /** Reports whether a known worker is still running. */
  poll(handle: WorkerHandle): Promise<WorkerStatus>;
  /** Classifies a known worker using backend-native status or heartbeats. */
  checkLiveness(
    handle: WorkerHandle,
    options: LivenessOptions,
  ): Promise<Liveness>;
  /** Idempotently stops a running worker. */
  terminate(handle: WorkerHandle): Promise<void>;
  /** Returns a completed worker's result, rejecting if none is available. */
  collect(handle: WorkerHandle): Promise<WorkerResult>;
  /** Optionally releases an underlying client or connection pool. */
  close?(): Promise<void>;
}

/**
 * A backend backed by an agent session stream, rather than only a child
 * process. Its event stream is the authoritative source for stall handling.
 * `recordStallDecision` must durably de-duplicate a restored decision.
 */
export interface ProgressReportingExecutionBackend extends ExecutionBackend {
  readonly progressCapability: "structured";
  readAgentProgress(handle: WorkerHandle): Promise<AgentProgressSnapshot>;
  recordStallDecision(
    handle: WorkerHandle,
    decision: AgentStallDecision,
  ): Promise<void>;
}

export function isProgressReportingExecutionBackend(
  backend: ExecutionBackend,
): backend is ProgressReportingExecutionBackend {
  return (
    (backend as Partial<ProgressReportingExecutionBackend>)
      .progressCapability === "structured" &&
    typeof (backend as Partial<ProgressReportingExecutionBackend>)
      .readAgentProgress === "function" &&
    typeof (backend as Partial<ProgressReportingExecutionBackend>)
      .recordStallDecision === "function"
  );
}

export interface LocalExecutionBackendOptions {
  /** Executable to run for each worker (e.g. process.execPath). */
  readonly command: string;
  /** Fixed args prepended before the per-worker environment. */
  readonly args?: readonly string[];
  /** Directory under which each worker's node dir is created. */
  readonly baseDir: string;
  /** Grace before SIGKILL after SIGTERM on terminate. Default 5000ms. */
  readonly killGraceMs?: number;
  /** Defaults to the least-privilege isolated environment policy. */
  readonly executionPolicy?: AgentExecutionPolicy;
}

/**
 * A worker as a local child process (plan §14). Each launch gets its own
 * node directory holding the protocol files.
 */
export function createLocalExecutionBackend(
  options: LocalExecutionBackendOptions,
): ExecutionBackend {
  const baseDir = resolve(options.baseDir);
  const args = [...(options.args ?? [])];
  const killGraceMs = options.killGraceMs ?? 5_000;
  const executionPolicy =
    options.executionPolicy ?? SAFE_AGENT_EXECUTION_POLICY;
  validateAgentExecutionPolicy(executionPolicy);
  const redact = createSecretRedactor(executionPolicy, process.env);
  if (!Number.isFinite(killGraceMs) || killGraceMs < 0) {
    throw new RangeError("killGraceMs must be a finite non-negative number");
  }

  interface LocalWorker {
    readonly handle: WorkerHandle;
    readonly nodeDir: string;
    readonly child: ChildProcess;
    readonly launchedAt: number;
    readonly exited: Promise<void>;
    processError: Error | undefined;
  }

  const workers = new Map<string, LocalWorker>();

  function workerFor(handle: WorkerHandle): LocalWorker {
    const worker = workers.get(handle.id);
    if (
      worker === undefined ||
      worker.handle.id !== handle.id ||
      worker.handle.runId !== handle.runId ||
      worker.handle.nodeId !== handle.nodeId
    ) {
      throw new Error(
        `Unknown worker handle for run "${handle.runId}", node "${handle.nodeId}"`,
      );
    }
    if (worker.processError !== undefined) {
      throw worker.processError;
    }
    return worker;
  }

  function hasExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  async function pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (error: unknown) {
      if (isErrnoException(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  async function heartbeatTimestamp(nodeDir: string): Promise<number | null> {
    const heartbeatPath = join(nodeDir, WORKER_HEARTBEAT_FILE);
    let source: string;
    try {
      source = await readFile(heartbeatPath, "utf8");
    } catch (error: unknown) {
      if (isErrnoException(error, "ENOENT")) {
        return null;
      }
      throw error;
    }

    let heartbeat: unknown;
    try {
      heartbeat = JSON.parse(source) as unknown;
    } catch (error: unknown) {
      throw new Error(`Invalid worker heartbeat at ${heartbeatPath}`, {
        cause: error,
      });
    }

    if (
      typeof heartbeat !== "object" ||
      heartbeat === null ||
      Array.isArray(heartbeat) ||
      !Object.hasOwn(heartbeat, "ts")
    ) {
      throw new Error(
        `Invalid worker heartbeat at ${heartbeatPath}: expected an object with a timestamp`,
      );
    }

    const timestamp = (heartbeat as Record<string, unknown>)["ts"];
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      throw new Error(
        `Invalid worker heartbeat at ${heartbeatPath}: "ts" must be a finite number`,
      );
    }
    return timestamp;
  }

  async function waitForGrace(
    worker: LocalWorker,
  ): Promise<"exited" | "expired"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolveExpired) => {
      timer = setTimeout(resolveExpired, killGraceMs, "expired");
    });

    const outcome = await Promise.race([
      worker.exited.then(() => "exited" as const),
      expired,
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    return outcome;
  }

  return {
    isolation: "host",
    async launch(spec, launchOptions): Promise<WorkerHandle> {
      // With a workspace, the worker runs there and its protocol files
      // live inside it; without one, it runs in its own node dir.
      const workspaceDir = launchOptions?.cwd;
      const nodeDirParent = workspaceDir ?? baseDir;
      await mkdir(nodeDirParent, { recursive: true });
      const nodeDir = await mkdtemp(
        join(
          nodeDirParent,
          `worker-${safePathPart(spec.runId)}-${safePathPart(spec.nodeId)}-a${String(spec.attempt)}-`,
        ),
      );

      const serialized = JSON.stringify(spec);
      if (serialized === undefined) {
        throw new Error("Worker spec is not JSON-serializable");
      }
      await writeFile(join(nodeDir, WORKER_SPEC_FILE), serialized, "utf8");

      const child = spawn(options.command, args, {
        cwd: workspaceDir ?? nodeDir,
        env: buildChildEnvironment(executionPolicy, process.env, {
          [NODE_DIR_ENV_VAR]: nodeDir,
        }),
        stdio: "ignore",
      });
      const handle: WorkerHandle = Object.freeze({
        id: nodeDir,
        runId: spec.runId,
        nodeId: spec.nodeId,
        nodeDir,
      });

      let resolveExited: (() => void) | undefined;
      const exited = new Promise<void>((resolvePromise) => {
        resolveExited = resolvePromise;
      });
      const worker: LocalWorker = {
        handle,
        nodeDir,
        child,
        launchedAt: Date.now(),
        exited,
        processError: undefined,
      };
      child.once("exit", () => {
        resolveExited?.();
      });
      child.once("error", (error) => {
        worker.processError = error;
        resolveExited?.();
      });

      await new Promise<void>((resolveSpawned, rejectSpawned) => {
        child.once("spawn", resolveSpawned);
        child.once("error", rejectSpawned);
      });
      workers.set(handle.id, worker);
      return handle;
    },

    poll(handle): Promise<WorkerStatus> {
      return Promise.resolve().then(() => {
        const worker = workerFor(handle);
        return hasExited(worker.child) ? "exited" : "running";
      });
    },

    async checkLiveness(handle, livenessOptions): Promise<Liveness> {
      const worker = workerFor(handle);
      const resultPath = join(worker.nodeDir, WORKER_RESULT_FILE);
      if (hasExited(worker.child) && !(await pathExists(resultPath))) {
        return "dead";
      }

      const lastHeartbeat =
        (await heartbeatTimestamp(worker.nodeDir)) ?? worker.launchedAt;
      return livenessOptions.now - lastHeartbeat > livenessOptions.idleTimeoutMs
        ? "idle"
        : "alive";
    },

    async terminate(handle): Promise<void> {
      const worker = workerFor(handle);
      if (hasExited(worker.child)) {
        await worker.exited;
        return;
      }

      worker.child.kill("SIGTERM");
      if ((await waitForGrace(worker)) === "exited") {
        return;
      }

      if (!hasExited(worker.child)) {
        worker.child.kill("SIGKILL");
      }
      await worker.exited;
    },

    async collect(handle): Promise<WorkerResult> {
      const worker = workerFor(handle);
      const resultPath = join(worker.nodeDir, WORKER_RESULT_FILE);
      let source: string;
      try {
        source = await readFile(resultPath, "utf8");
      } catch (error: unknown) {
        if (isErrnoException(error, "ENOENT")) {
          throw new Error(
            `Worker for run "${handle.runId}", node "${handle.nodeId}" did not produce ${WORKER_RESULT_FILE}`,
            { cause: error },
          );
        }
        throw error;
      }

      let result: unknown;
      try {
        result = JSON.parse(source) as unknown;
      } catch (error: unknown) {
        throw new Error(`Invalid worker result at ${resultPath}`, {
          cause: error,
        });
      }
      const parsed = parseWorkerResult(result);
      const redacted =
        parsed.status === "failed" && parsed.error !== undefined
          ? { ...parsed, error: redact(parsed.error) }
          : parsed;
      if (redacted !== parsed) {
        const temporaryPath = `${resultPath}.${String(process.pid)}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(redacted), "utf8");
        await rename(temporaryPath, resultPath);
      }
      return redacted;
    },
  };
}

function safePathPart(value: string): string {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
  return sanitized.length === 0 ? "_" : sanitized;
}

function isErrnoException(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
