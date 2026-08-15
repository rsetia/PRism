import type { GraphCompileError } from "./errors.js";
import type {
  CompiledGraph,
  CompiledNode,
  GraphDefinition,
  JsonValue,
} from "./types.js";

export type CompileResult =
  | { readonly ok: true; readonly graph: CompiledGraph }
  | { readonly ok: false; readonly errors: readonly GraphCompileError[] };

function compareNodeIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    const entries = value as readonly JsonValue[];
    return entries.map((entry) => cloneJsonValue(entry));
  }

  const clone: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const [key, entry] of Object.entries(value)) {
    clone[key] = cloneJsonValue(entry);
  }
  return clone;
}

function deepFreeze<T>(value: T, seen: Set<object> = new Set()): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }

  return Object.freeze(value);
}

function participatesInCycle(
  startNodeId: string,
  graph: GraphDefinition,
  remainingNodeIds: ReadonlySet<string>,
): boolean {
  const visited = new Set<string>();
  const toVisit = [startNodeId];

  while (toVisit.length > 0) {
    const nodeId = toVisit.pop();
    if (nodeId === undefined || visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);

    const node = graph.nodes[nodeId];
    if (node === undefined) {
      continue;
    }

    for (const dependencyId of node.dependsOn) {
      // A self-edge has its own, more specific compile error.
      if (dependencyId === nodeId) {
        continue;
      }
      if (dependencyId === startNodeId) {
        return true;
      }
      if (remainingNodeIds.has(dependencyId) && !visited.has(dependencyId)) {
        toVisit.push(dependencyId);
      }
    }
  }

  return false;
}

/**
 * Cross-node invariants and precomputation. Pure: no I/O, no clock, and
 * deterministic — equal inputs compile to identical output, always.
 *
 * Order of work (plan §2, step 3):
 * 1. every dependsOn entry names an existing node   -> UNKNOWN_DEPENDENCY
 * 2. no node depends on itself                      -> SELF_DEPENDENCY
 * 3. Kahn's algorithm for the stable topological order — ready set sorted
 *    lexicographically by node ID (never declaration order: JavaScript
 *    reorders numeric-like object keys). From the nodes left over when the
 *    ready set empties, report only cycle participants -> CYCLE
 * 4. resolve finalNode: declared (and existing      -> UNKNOWN_FINAL_NODE)
 *    or inferred from exactly one sink              -> AMBIGUOUS_FINAL_NODE
 * 5. precompute dependents (reverse edges) for the engine
 * 6. deep Object.freeze the result — readonly types vanish at runtime;
 *    the freeze is the real immutability
 */
export function compileGraph(graph: GraphDefinition): CompileResult {
  const errors: GraphCompileError[] = [];
  const nodeIds = Object.keys(graph.nodes).sort(compareNodeIds);
  const nodeIdSet = new Set(nodeIds);
  const dependentsByNodeId = new Map<string, string[]>();
  const remainingDependencyCount = new Map<string, number>();

  for (const nodeId of nodeIds) {
    dependentsByNodeId.set(nodeId, []);
    remainingDependencyCount.set(nodeId, 0);
  }

  for (const nodeId of nodeIds) {
    const node = graph.nodes[nodeId];
    if (node === undefined) {
      continue;
    }

    for (const dependencyId of node.dependsOn) {
      if (!nodeIdSet.has(dependencyId)) {
        errors.push({
          code: "UNKNOWN_DEPENDENCY",
          nodeId,
          dependencyId,
        });
        continue;
      }

      if (dependencyId === nodeId) {
        errors.push({ code: "SELF_DEPENDENCY", nodeId });
        continue;
      }

      const dependents = dependentsByNodeId.get(dependencyId);
      if (dependents !== undefined) {
        dependents.push(nodeId);
      }
      const dependencyCount = remainingDependencyCount.get(nodeId);
      if (dependencyCount !== undefined) {
        remainingDependencyCount.set(nodeId, dependencyCount + 1);
      }
    }
  }

  for (const dependents of dependentsByNodeId.values()) {
    dependents.sort(compareNodeIds);
  }

  const readyNodeIds = nodeIds.filter(
    (nodeId) => remainingDependencyCount.get(nodeId) === 0,
  );
  const order: string[] = [];

  while (readyNodeIds.length > 0) {
    const nodeId = readyNodeIds.shift();
    if (nodeId === undefined) {
      break;
    }
    order.push(nodeId);

    const dependents = dependentsByNodeId.get(nodeId) ?? [];
    for (const dependentId of dependents) {
      const previousCount = remainingDependencyCount.get(dependentId);
      if (previousCount === undefined) {
        continue;
      }

      const nextCount = previousCount - 1;
      remainingDependencyCount.set(dependentId, nextCount);
      if (nextCount === 0) {
        readyNodeIds.push(dependentId);
        readyNodeIds.sort(compareNodeIds);
      }
    }
  }

  if (order.length !== nodeIds.length) {
    const orderedNodeIds = new Set(order);
    const remainingNodeIds = new Set(
      nodeIds.filter((nodeId) => !orderedNodeIds.has(nodeId)),
    );
    const cycleNodeIds = [...remainingNodeIds].filter((nodeId) =>
      participatesInCycle(nodeId, graph, remainingNodeIds),
    );

    if (cycleNodeIds.length > 0) {
      errors.push({ code: "CYCLE", nodeIds: cycleNodeIds });
    }
  }

  let finalNode: string | undefined;
  if (graph.finalNode !== undefined) {
    if (nodeIdSet.has(graph.finalNode)) {
      finalNode = graph.finalNode;
    } else {
      errors.push({
        code: "UNKNOWN_FINAL_NODE",
        finalNode: graph.finalNode,
      });
    }
  } else if (errors.length === 0) {
    const sinkIds = nodeIds.filter(
      (nodeId) => dependentsByNodeId.get(nodeId)?.length === 0,
    );
    if (sinkIds.length === 1) {
      finalNode = sinkIds[0];
    } else {
      errors.push({ code: "AMBIGUOUS_FINAL_NODE", sinkIds });
    }
  }

  if (errors.length > 0 || finalNode === undefined) {
    return { ok: false, errors };
  }

  const compiledNodes: Record<string, CompiledNode> = Object.create(
    null,
  ) as Record<string, CompiledNode>;
  for (const nodeId of nodeIds) {
    const node = graph.nodes[nodeId];
    if (node === undefined) {
      continue;
    }

    const compiledNode = {
      id: nodeId,
      executor: node.executor,
      kind: node.kind ?? "task",
      dependsOn: [...node.dependsOn],
      dependents: [...(dependentsByNodeId.get(nodeId) ?? [])],
    };
    const when =
      node.when === undefined
        ? undefined
        : (cloneJsonValue(node.when) as typeof node.when);
    compiledNodes[nodeId] =
      node.config === undefined
        ? when === undefined
          ? compiledNode
          : { ...compiledNode, when }
        : {
            ...compiledNode,
            config: cloneJsonValue(node.config),
            ...(when === undefined ? {} : { when }),
          };
  }

  return {
    ok: true,
    graph: deepFreeze({
      version: 1,
      nodes: compiledNodes,
      order,
      finalNode,
    }),
  };
}
