/**
 * Graph data model. Pure types — no logic, no Node.js imports.
 */

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
  readonly config?: JsonValue;
}

/**
 * A parsed, shape-valid graph. Cross-node invariants (cycles, unknown
 * dependencies, final-node resolution) are compileGraph's job, not this
 * type's.
 */
export interface GraphDefinition {
  readonly version: 1;
  readonly nodes: Readonly<Record<string, NodeDefinition>>;
  readonly finalNode?: string;
}

/** A node with everything the engine needs precomputed. */
export interface CompiledNode {
  readonly id: string;
  readonly executor: string;
  readonly dependsOn: readonly string[];
  /** Reverse edges, precomputed so the engine can promote dependents. */
  readonly dependents: readonly string[];
  readonly config?: JsonValue;
}

/**
 * The immutable execution plan. Deep-frozen at runtime by compileGraph —
 * the readonly modifiers here vanish after compilation to JavaScript.
 */
export interface CompiledGraph {
  readonly version: 1;
  readonly nodes: Readonly<Record<string, CompiledNode>>;
  /** Stable topological order: Kahn's algorithm, lexicographic tie-break. */
  readonly order: readonly string[];
  /** Always resolved: declared and validated, or inferred from a single sink. */
  readonly finalNode: string;
}
