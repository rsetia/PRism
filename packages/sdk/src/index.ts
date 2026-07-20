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

export const SDK_VERSION = "0.1.0-alpha.0";
