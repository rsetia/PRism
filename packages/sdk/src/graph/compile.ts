import type { GraphCompileError } from "./errors.js";
import type { CompiledGraph, GraphDefinition } from "./types.js";

export type CompileResult =
  | { readonly ok: true; readonly graph: CompiledGraph }
  | { readonly ok: false; readonly errors: readonly GraphCompileError[] };

/**
 * Cross-node invariants and precomputation. Pure: no I/O, no clock, and
 * deterministic — equal inputs compile to identical output, always.
 *
 * Order of work (plan §2, step 3):
 * 1. every dependsOn entry names an existing node   -> UNKNOWN_DEPENDENCY
 * 2. no node depends on itself                      -> SELF_DEPENDENCY
 * 3. Kahn's algorithm for the stable topological order — ready set sorted
 *    lexicographically by node ID (never declaration order: JavaScript
 *    reorders numeric-like object keys). Nodes left over when the ready
 *    set empties are the cycle                      -> CYCLE
 * 4. resolve finalNode: declared (and existing      -> UNKNOWN_FINAL_NODE)
 *    or inferred from exactly one sink              -> AMBIGUOUS_FINAL_NODE
 * 5. precompute dependents (reverse edges) for the engine
 * 6. deep Object.freeze the result — readonly types vanish at runtime;
 *    the freeze is the real immutability
 */
export function compileGraph(graph: GraphDefinition): CompileResult {
  // TODO(section 2, step 3): implement per the checklist above.
  void graph;
  throw new Error("TODO: compileGraph not implemented");
}
