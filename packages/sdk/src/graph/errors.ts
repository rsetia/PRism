/**
 * Errors are data: a stable code plus structured fields. Human-readable
 * messages are derived presentation — rendered elsewhere (the CLI, later),
 * never part of an error's identity. Tests match on codes and fields only.
 */

/** Shape-level rejections found by parseGraph (per-field, single input). */
export type GraphParseError =
  | { readonly code: "INVALID_ROOT" }
  | { readonly code: "UNSUPPORTED_VERSION"; readonly found: unknown }
  | { readonly code: "UNKNOWN_PROPERTY"; readonly path: string }
  | { readonly code: "EMPTY_GRAPH" }
  | { readonly code: "INVALID_NODE_ID"; readonly nodeId: string }
  | {
      readonly code: "INVALID_NODE";
      readonly nodeId: string;
      readonly property: string;
    }
  | {
      readonly code: "DUPLICATE_DEPENDENCY";
      readonly nodeId: string;
      readonly dependencyId: string;
    }
  | { readonly code: "INVALID_FINAL_NODE" };

/** Cross-node invariant violations found by compileGraph. */
export type GraphCompileError =
  | { readonly code: "SELF_DEPENDENCY"; readonly nodeId: string }
  | {
      readonly code: "UNKNOWN_DEPENDENCY";
      readonly nodeId: string;
      readonly dependencyId: string;
    }
  | { readonly code: "CYCLE"; readonly nodeIds: readonly string[] }
  | { readonly code: "UNKNOWN_FINAL_NODE"; readonly finalNode: string }
  | {
      readonly code: "AMBIGUOUS_FINAL_NODE";
      readonly sinkIds: readonly string[];
    };
