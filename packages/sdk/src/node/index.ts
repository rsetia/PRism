/**
 * Node-only entry point: `@rsetia/agent-graph/node`. Everything here
 * touches Node built-ins (child_process, fs), so it is kept out of the
 * core `.` entry — a core-only consumer never loads it (plan §7/§14).
 */
export type { Heartbeat, WorkerResult, WorkerSpec } from "./worker-protocol.js";
export {
  NODE_DIR_ENV_VAR,
  parseWorkerResult,
  WORKER_HEARTBEAT_FILE,
  WORKER_RESULT_FILE,
  WORKER_SPEC_FILE,
} from "./worker-protocol.js";
export type {
  ExecutionBackend,
  LaunchOptions,
  Liveness,
  LivenessOptions,
  LocalExecutionBackendOptions,
  WorkerHandle,
  WorkerStatus,
} from "./execution-backend.js";
export { createLocalExecutionBackend } from "./execution-backend.js";
export type {
  GitWorktreeProvisionerOptions,
  ProvisionInput,
  WorkspaceHandle,
  WorkspaceProvisioner,
} from "./workspace-provisioner.js";
export { createGitWorktreeProvisioner } from "./workspace-provisioner.js";
export type { SubprocessExecutorOptions } from "./subprocess-executor.js";
export { createSubprocessExecutor } from "./subprocess-executor.js";
