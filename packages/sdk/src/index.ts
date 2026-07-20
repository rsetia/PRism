/**
 * Public entry point for @rsetia/agent-graph. Everything importable by
 * consumers is re-exported here — internal modules are not reachable.
 */
export { parseGraph } from "./graph/parse.js";
export type { ParseResult } from "./graph/parse.js";
export { compileGraph } from "./graph/compile.js";
export type { CompileResult } from "./graph/compile.js";
export type {
  CompiledGraph,
  CompiledNode,
  GraphDefinition,
  JsonValue,
  NodeDefinition,
} from "./graph/types.js";
export type { GraphCompileError, GraphParseError } from "./graph/errors.js";
export {
  IllegalTransitionError,
  reduceNodeState,
} from "./runtime/transitions.js";
export { TERMINAL_NODE_STATES } from "./runtime/types.js";
export type { NodeFailure, NodeState, RunOutcome } from "./runtime/types.js";
export type { PersistedRunEvent, RunEvent } from "./runtime/events.js";
export type {
  CreateRunInput,
  ExecutionContext,
  ExecutorDefinition,
  ExecutorRegistry,
  NodeExecutionOutcome,
  RunStore,
  StoredRun,
} from "./runtime/ports.js";
export { createExecutorRegistry } from "./runtime/registry.js";
export { normalizeThrownCause } from "./runtime/failures.js";
export { createMemoryStore } from "./adapters/memory-store.js";
export { builtinExecutors } from "./adapters/builtin-executors.js";

export const SDK_VERSION = "0.1.0-alpha.0";
