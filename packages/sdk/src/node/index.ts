/**
 * Node-only entry point: `@rsetia/prism/node`. Everything here
 * touches Node built-ins (child_process, fs), so it is kept out of the
 * core `.` entry — a core-only consumer never loads it (plan §7/§14).
 */
export type { SqliteStoreOptions } from "./sqlite-store.js";
export { createSqliteStore } from "./sqlite-store.js";
export type {
  Heartbeat,
  WorkerPhaseUpdate,
  WorkerResult,
  WorkerSpec,
} from "./worker-protocol.js";
export {
  NODE_DIR_ENV_VAR,
  parseWorkerPhaseUpdate,
  parseWorkerResult,
  WORKER_HEARTBEAT_FILE,
  WORKER_PHASE_FILE,
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
  AgentExecutionMode,
  AgentExecutionPolicy,
  ChildEnvironmentPolicy,
  SecretRedactor,
} from "./execution-policy.js";
export {
  buildChildEnvironment,
  createSecretRedactor,
  SAFE_AGENT_EXECUTION_POLICY,
  TRUSTED_LOCAL_AGENT_EXECUTION_POLICY,
  validateAgentExecutionPolicy,
} from "./execution-policy.js";
export type {
  GitWorktreeProvisionerOptions,
  ProvisionInput,
  WorkspaceHandle,
  WorkspaceProvisioner,
  WorkspaceReleaseOptions,
} from "./workspace-provisioner.js";
export { createGitWorktreeProvisioner } from "./workspace-provisioner.js";
export type { SubprocessExecutorOptions } from "./subprocess-executor.js";
export { createSubprocessExecutor } from "./subprocess-executor.js";
export type {
  ArtifactLocator,
  ArtifactRef,
  ArtifactStore,
  PutArtifactInput,
} from "../runtime/ports.js";
export type { LocalArtifactStoreOptions } from "./artifact-store.js";
export { createLocalArtifactStore } from "./artifact-store.js";
export type {
  LogBackend,
  LogTarget,
  LogWriter,
  ReadLogOptions,
} from "../runtime/ports.js";
export type { FileLogBackendOptions } from "./log-backend.js";
export { createFileLogBackend } from "./log-backend.js";
export type {
  CodexEngine,
  CodexEngineOptions,
  CodexExecutionInput,
  CodexExecutorContract,
  CodexPromptInput,
  CodexSandbox,
} from "./codex-engine.js";
export { buildCodexPrompt, createCodexEngine } from "./codex-engine.js";
export type {
  AgentSession,
  AgentSessionBackend,
  AgentSessionEngineOptions,
  AgentSessionEvent,
  AgentSessionInput,
  AgentSessionKey,
  AgentSessionStore,
} from "./agent-session-backend.js";
export {
  createFileAgentSessionStore,
  runAgentSession,
} from "./agent-session-backend.js";
export type { CodexAppServerClient } from "./codex-app-server-backend.js";
export { createCodexAppServerBackend } from "./codex-app-server-backend.js";
export type { CodexAppServerStdioClientOptions } from "./codex-app-server-client.js";
export { createCodexAppServerStdioClient } from "./codex-app-server-client.js";
export type {
  FinalizePrConfig,
  ImplementConfig,
  MergeResolveConfig,
  ReviewConfig,
  WorkItem,
} from "./codex-contracts.js";
export {
  buildFinalizePrContract,
  buildImplementContract,
  buildMergeResolveContract,
  codexContractForSpec,
  parseFinalizePrConfig,
  parseImplementConfig,
  parseMergeResolveConfig,
} from "./codex-contracts.js";
export type {
  CommandResult,
  CommandRunner,
  RunCommandOptions,
} from "./command-runner.js";
export { createExecFileRunner } from "./command-runner.js";
export type {
  BeadsUpdateConfig,
  BeadsUpdateExecutorOptions,
  MergePrConfig,
  MergePrExecutorOptions,
} from "./cli-builtins.js";
export {
  createBeadsUpdateExecutor,
  createMergePrExecutor,
  parseBeadsUpdateConfig,
  parseMergePrConfig,
} from "./cli-builtins.js";
export type { CodexExecutorOptions } from "./codex-executor.js";
export { createCodexExecutor } from "./codex-executor.js";
