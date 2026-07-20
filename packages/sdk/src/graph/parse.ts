import type { GraphParseError } from "./errors.js";
import type { GraphDefinition, JsonValue, NodeDefinition } from "./types.js";

export type ParseResult =
  | { readonly ok: true; readonly graph: GraphDefinition }
  | { readonly ok: false; readonly errors: readonly GraphParseError[] };

const ROOT_PROPERTIES = new Set(["version", "nodes", "finalNode"]);
const NODE_PROPERTIES = new Set(["executor", "dependsOn", "config"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value !== "object") {
    return false;
  }

  if (ancestors.has(value)) {
    return false;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, nextAncestors));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && isJsonValue(value[key], nextAncestors),
  );
}

/**
 * The trust boundary: unknown in, typed graph (or structured errors) out.
 *
 * Normative rules (plan §2, decided):
 * - root must be a plain object                          -> INVALID_ROOT
 * - version must be the literal number 1                 -> UNSUPPORTED_VERSION
 * - unknown properties rejected, root and node level     -> UNKNOWN_PROPERTY
 * - nodes must be a non-empty object                     -> EMPTY_GRAPH
 * - node IDs are non-empty strings                       -> INVALID_NODE_ID
 * - executor: non-empty string; dependsOn: string array  -> INVALID_NODE
 * - duplicate dependsOn entries rejected                 -> DUPLICATE_DEPENDENCY
 * - finalNode, when present, is a non-empty string       -> INVALID_FINAL_NODE
 * - omitted dependsOn normalizes to []
 * - config passes through untouched (opaque JSON)
 *
 * Collect every error in one pass — don't stop at the first.
 */
export function parseGraph(input: unknown): ParseResult {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ code: "INVALID_ROOT" }] };
  }

  const errors: GraphParseError[] = [];

  if (input["version"] !== 1) {
    errors.push({
      code: "UNSUPPORTED_VERSION",
      found: input["version"],
    });
  }

  for (const property of Object.keys(input)) {
    if (!ROOT_PROPERTIES.has(property)) {
      errors.push({ code: "UNKNOWN_PROPERTY", path: property });
    }
  }

  const parsedNodes: Record<string, NodeDefinition> = Object.create(
    null,
  ) as Record<string, NodeDefinition>;
  const nodes = input["nodes"];

  if (!isPlainObject(nodes) || Object.keys(nodes).length === 0) {
    errors.push({ code: "EMPTY_GRAPH" });
  } else {
    for (const [nodeId, candidate] of Object.entries(nodes)) {
      if (nodeId.length === 0) {
        errors.push({ code: "INVALID_NODE_ID", nodeId });
      }

      if (!isPlainObject(candidate)) {
        errors.push({
          code: "INVALID_NODE",
          nodeId,
          property: "node",
        });
        continue;
      }

      for (const property of Object.keys(candidate)) {
        if (!NODE_PROPERTIES.has(property)) {
          errors.push({
            code: "UNKNOWN_PROPERTY",
            path: `nodes.${nodeId}.${property}`,
          });
        }
      }

      const executor = candidate["executor"];
      const executorIsValid =
        typeof executor === "string" && executor.length > 0;
      if (!executorIsValid) {
        errors.push({
          code: "INVALID_NODE",
          nodeId,
          property: "executor",
        });
      }

      const dependsOn: string[] = [];
      let dependsOnIsValid = true;
      if (Object.hasOwn(candidate, "dependsOn")) {
        const dependencies = candidate["dependsOn"];
        if (!Array.isArray(dependencies)) {
          dependsOnIsValid = false;
        } else {
          const seenDependencies = new Set<string>();
          const reportedDuplicates = new Set<string>();

          for (const dependency of dependencies) {
            if (typeof dependency !== "string") {
              dependsOnIsValid = false;
              continue;
            }

            dependsOn.push(dependency);
            if (seenDependencies.has(dependency)) {
              if (!reportedDuplicates.has(dependency)) {
                errors.push({
                  code: "DUPLICATE_DEPENDENCY",
                  nodeId,
                  dependencyId: dependency,
                });
                reportedDuplicates.add(dependency);
              }
            } else {
              seenDependencies.add(dependency);
            }
          }
        }
      }

      if (!dependsOnIsValid) {
        errors.push({
          code: "INVALID_NODE",
          nodeId,
          property: "dependsOn",
        });
      }

      const hasConfig = Object.hasOwn(candidate, "config");
      const config = candidate["config"];
      const configIsValid = !hasConfig || isJsonValue(config);
      if (!configIsValid) {
        errors.push({
          code: "INVALID_NODE",
          nodeId,
          property: "config",
        });
      }

      if (executorIsValid && dependsOnIsValid && configIsValid) {
        parsedNodes[nodeId] = hasConfig
          ? { executor, dependsOn, config: config as JsonValue }
          : { executor, dependsOn };
      }
    }
  }

  const hasFinalNode = Object.hasOwn(input, "finalNode");
  const finalNode = input["finalNode"];
  const finalNodeIsValid =
    !hasFinalNode || (typeof finalNode === "string" && finalNode.length > 0);
  if (!finalNodeIsValid) {
    errors.push({ code: "INVALID_FINAL_NODE" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    graph: hasFinalNode
      ? { version: 1, nodes: parsedNodes, finalNode: finalNode as string }
      : { version: 1, nodes: parsedNodes },
  };
}
