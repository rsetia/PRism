/**
 * Public entry point for @rsetia/prism. Everything importable by
 * consumers is re-exported here — internal modules are not reachable.
 */
export { parseGraph } from "./graph/parse.js";
export type { ParseResult } from "./graph/parse.js";
export { compileGraph } from "./graph/compile.js";
export type { CompileResult } from "./graph/compile.js";
export type {
  CompiledGraph,
  CompiledNode,
  ExecutionCondition,
  GraphDefinition,
  JsonValue,
  NodeDefinition,
  NodeKind,
  ResourceDefinition,
} from "./graph/types.js";
export type { GraphCompileError, GraphParseError } from "./graph/errors.js";
export {
  buildBeadsGraph,
  parseBeadsJsonl,
  refreshBeadsNodeConfigs,
} from "./beads/generate.js";
export type {
  Bead,
  BeadsGraphOptions,
  BeadsReviewConfig,
  BeadsSpecDocument,
  FinalPullRequestOptions,
  ReviewGate,
} from "./beads/generate.js";
export {
  IllegalTransitionError,
  reduceNodeState,
} from "./runtime/transitions.js";
export { TERMINAL_NODE_STATES } from "./runtime/types.js";
export {
  parseProofOfWork,
  PROOF_OF_WORK_VERSION,
  tryParseProofOfWork,
} from "./runtime/proof-of-work.js";
export type {
  CommitEvidence,
  ProofOfWorkV1,
  PullRequestEvidence,
  ReviewVerdictEvidence,
  ValidationEvidence,
} from "./runtime/proof-of-work.js";
export type {
  FailureClass,
  NodeFailure,
  NodeState,
  RunOutcome,
} from "./runtime/types.js";
export {
  applyJitter,
  computeBackoffMs,
  DEFAULT_FAILURE_CLASS,
  isAdjudicated,
  isFailureRetryable,
  isResumableFailure,
  isRetryable,
  NO_RETRIES,
  RESUMABLE_FAILURE_CLASSES,
  resolveFailureClass,
  RETRY_TRANSIENT,
  transientInfraRetryPolicy,
} from "./runtime/retry.js";
export type { RetryPolicy } from "./runtime/retry.js";
export { createManualClock, createSystemClock } from "./adapters/clock.js";
export type { ManualClock } from "./adapters/clock.js";
export { inspectRun, watchRun } from "./runtime/inspect.js";
export {
  combineCriticalPathPhases,
  computeRunStats,
  readRunStats,
} from "./runtime/stats.js";
export type {
  IdleGap,
  IdleStats,
  MergeStats,
  PhaseShare,
  PhaseStat,
  RealizedCriticalPath,
  ReviewRounds,
  RunStats,
  RunStatsOptions,
} from "./runtime/stats.js";
export { summarizeUsage } from "./runtime/usage.js";
export type { AttemptUsage, UsageTotals } from "./runtime/usage.js";
export type {
  CriticalPathTiming,
  InspectRunOptions,
  NodeInspection,
  NodeTiming,
  NodeTimingPhase,
  PhaseDuration,
  RunInspection,
  RunTiming,
  SchedulerUtilization,
  WatchRunOptions,
} from "./runtime/inspect.js";
export {
  buildRefreshRevision,
  compileRefresh,
  isRefreshRevision,
  submitGraphProposal,
} from "./runtime/graph-revision.js";
export type {
  GraphExpansionProposal,
  GraphProposalDecision,
  GraphProposalPolicy,
  GraphProposalResult,
  GraphRefresh,
  GraphRevision,
} from "./runtime/graph-revision.js";
export {
  abortRun,
  applyAdminRequestOffline,
  LIVE_RESETTABLE_STATES,
  planAdminReset,
  planRefreshReset,
  refreshRevisionFor,
  resetRun,
  resumableFailedNodes,
} from "./runtime/admin.js";
export type {
  AdminResetPlan,
  OfflineAdminResult,
  ResetRunOptions,
} from "./runtime/admin.js";
export type {
  NodePhase,
  PersistedRunEvent,
  RunEvent,
  UsageReport,
  WorkerPhase,
} from "./runtime/events.js";
export { NODE_PHASES, WORKER_PHASES } from "./runtime/events.js";
export type { UsagePriceMetadata } from "./runtime/usage.js";
export type {
  AdminRequest,
  AdminRequestAction,
  AdminRequestResolver,
  AdminRequestStatus,
  EnqueueAdminRequestInput,
  ResolveAdminRequestInput,
  ResolveAdminRequestResult,
  Clock,
  CreateRunInput,
  ArtifactLocator,
  ArtifactRef,
  ArtifactStore,
  LogBackend,
  LogTarget,
  LogWriter,
  ReadLogOptions,
  RunSummary,
  ExecutionContext,
  ExecutorDefinition,
  ExecutorRegistry,
  NodeExecutionOutcome,
  PutArtifactInput,
  RunStore,
  RunLease,
  RunLeaseStatus,
  StoredRun,
} from "./runtime/ports.js";
export {
  classifyWorkerFailure,
  describeFailure,
  failureDisposition,
  isDeclaredBlocker,
} from "./runtime/disposition.js";
export type {
  DescribeFailureContext,
  FailureDescription,
  FailureDisposition,
} from "./runtime/disposition.js";
export { createEngine } from "./runtime/engine.js";
export type {
  Engine,
  EngineOptions,
  RunHandle,
  RunOptions,
} from "./runtime/engine.js";
export { createExecutorRegistry } from "./runtime/registry.js";
export { normalizeThrownCause } from "./runtime/failures.js";
export { createMemoryStore } from "./adapters/memory-store.js";
export { builtinExecutors } from "./adapters/builtin-executors.js";

export const SDK_VERSION = "0.1.0-alpha.0";
