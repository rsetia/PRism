/**
 * Graph data model. Pure types — no logic, no Node.js imports.
 */

/**
 * A node's category (plan §13, from PRism-py). It selects how upstream
 * outputs are shaped into the node's input — `task` nodes consume text,
 * `merge` nodes consume ordered upstream artifacts. The union is
 * extensible; unspecified defaults to `task`.
 */
export type NodeKind = "task" | "merge";

/** A data-only gate evaluated from versioned upstream proof outputs. */
export type ExecutionCondition =
  | { readonly all: readonly ExecutionCondition[] }
  | { readonly any: readonly ExecutionCondition[] }
  | { readonly not: ExecutionCondition }
  | { readonly predicate: "changed_path"; readonly matches: string }
  | { readonly predicate: "diff_present"; readonly equals: boolean }
  | {
      readonly predicate: "validation_status";
      readonly equals: "passed" | "failed";
    }
  | {
      readonly predicate: "review_status";
      readonly equals: "approved" | "changes_requested";
    }
  | { readonly predicate: "unresolved_risk"; readonly equals: boolean };

/** A durable scheduler semaphore declared by the graph. */
export interface ResourceDefinition {
  readonly capacity: number;
}

/** `config` is opaque JSON: the SDK never interprets it. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A node as it exists after parsing. `dependsOn` is always present —
 * parseGraph normalizes an omitted field to []. Order matters: it is also
 * the node's ordered inputs.
 */
export interface NodeDefinition {
  readonly executor: string;
  readonly dependsOn: readonly string[];
  /** Defaults to "task" when the source omits it. */
  readonly kind?: NodeKind;
  /** Resources acquired atomically before this node starts. */
  readonly resources?: readonly string[];
  readonly config?: JsonValue;
  /** Available only in graph version 2; false means this node is skipped. */
  readonly when?: ExecutionCondition;
}

/**
 * A parsed, shape-valid graph. Cross-node invariants (cycles, unknown
 * dependencies, final-node resolution) are compileGraph's job, not this
 * type's.
 */
export interface GraphDefinition {
  readonly version: 1 | 2;
  readonly resources?: Readonly<Record<string, ResourceDefinition>>;
  readonly nodes: Readonly<Record<string, NodeDefinition>>;
  readonly finalNode?: string;
}

/** A node with everything the engine needs precomputed. */
export interface CompiledNode {
  readonly id: string;
  readonly executor: string;
  /** Resolved to a concrete kind — "task" when the source omitted it. */
  readonly kind: NodeKind;
  readonly dependsOn: readonly string[];
  readonly resources: readonly string[];
  /** Reverse edges, precomputed so the engine can promote dependents. */
  readonly dependents: readonly string[];
  readonly config?: JsonValue;
  readonly when?: ExecutionCondition;
}

/**
 * The immutable execution plan. Deep-frozen at runtime by compileGraph —
 * the readonly modifiers here vanish after compilation to JavaScript.
 */
export interface CompiledGraph {
  readonly version: 1 | 2;
  readonly resources: Readonly<Record<string, ResourceDefinition>>;
  readonly nodes: Readonly<Record<string, CompiledNode>>;
  /** Stable topological order: Kahn's algorithm, lexicographic tie-break. */
  readonly order: readonly string[];
  /** Always resolved: declared and validated, or inferred from a single sink. */
  readonly finalNode: string;
}
