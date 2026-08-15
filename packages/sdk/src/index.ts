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
} from "./graph/types.js";
export type { GraphCompileError, GraphParseError } from "./graph/errors.js";
export { buildBeadsGraph, parseBeadsJsonl } from "./beads/generate.js";
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
export type {
  FailureClass,
  NodeFailure,
  NodeState,
  RunOutcome,
} from "./runtime/types.js";
export {
  computeBackoffMs,
  DEFAULT_FAILURE_CLASS,
  isRetryable,
  NO_RETRIES,
  resolveFailureClass,
  RETRY_TRANSIENT,
} from "./runtime/retry.js";
export type { RetryPolicy } from "./runtime/retry.js";
export { createManualClock, createSystemClock } from "./adapters/clock.js";
export type { ManualClock } from "./adapters/clock.js";
export { inspectRun, watchRun } from "./runtime/inspect.js";
export type {
  CriticalPathTiming,
  NodeInspection,
  NodeTiming,
  NodeTimingPhase,
  PhaseDuration,
  RunInspection,
  RunTiming,
  WatchRunOptions,
} from "./runtime/inspect.js";
export { abortRun, resetRun } from "./runtime/admin.js";
export type { ResetRunOptions } from "./runtime/admin.js";
export type {
  NodePhase,
  PersistedRunEvent,
  RunEvent,
  WorkerPhase,
} from "./runtime/events.js";
export { NODE_PHASES, WORKER_PHASES } from "./runtime/events.js";
export type {
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
  StoredRun,
} from "./runtime/ports.js";
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
