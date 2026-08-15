import type { GraphParseError } from "./errors.js";
import type {
  GraphDefinition,
  JsonValue,
  NodeDefinition,
  ExecutionCondition,
  NodeKind,
  ResourceDefinition,
} from "./types.js";
import { isJsonValue, isPlainObject } from "../internal/json.js";

export type ParseResult =
  | { readonly ok: true; readonly graph: GraphDefinition }
  | { readonly ok: false; readonly errors: readonly GraphParseError[] };

const ROOT_PROPERTIES = new Set(["version", "resources", "nodes", "finalNode"]);
const NODE_PROPERTIES = new Set([
  "executor",
  "dependsOn",
  "kind",
  "resources",
  "config",
  "when",
]);

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
 * - kind, when present, is "task" or "merge"            -> INVALID_KIND
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

  if (input["version"] !== 1 && input["version"] !== 2) {
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

  const parsedResources: Record<string, ResourceDefinition> = Object.create(
    null,
  ) as Record<string, ResourceDefinition>;
  const resources = input["resources"];
  let resourcesAreValid = true;
  if (Object.hasOwn(input, "resources")) {
    if (!isPlainObject(resources)) {
      errors.push({ code: "INVALID_RESOURCES", path: "resources" });
      resourcesAreValid = false;
    } else {
      for (const [resourceId, candidate] of Object.entries(resources)) {
        if (resourceId.length === 0) {
          errors.push({ code: "INVALID_RESOURCES", path: "resources." });
          resourcesAreValid = false;
          continue;
        }
        if (
          !isPlainObject(candidate) ||
          Object.keys(candidate).some((key) => key !== "capacity") ||
          !Number.isSafeInteger(candidate["capacity"]) ||
          (candidate["capacity"] as number) < 1
        ) {
          errors.push({
            code: "INVALID_RESOURCES",
            path: `resources.${resourceId}`,
          });
          resourcesAreValid = false;
          continue;
        }
        parsedResources[resourceId] = {
          capacity: candidate["capacity"] as number,
        };
      }
    }
  }

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

      const hasKind = Object.hasOwn(candidate, "kind");
      const kind = candidate["kind"];
      const kindIsValid = !hasKind || kind === "task" || kind === "merge";
      if (!kindIsValid) {
        errors.push({ code: "INVALID_KIND", nodeId, found: kind });
      }

      const hasWhen = Object.hasOwn(candidate, "when");
      const parsedWhen = hasWhen
        ? parseCondition(candidate["when"], nodeId, "when", errors)
        : undefined;
      if (hasWhen && input["version"] === 1) {
        errors.push({ code: "CONDITION_REQUIRES_VERSION_2", nodeId });

      const requestedResources: string[] = [];
      let requestedResourcesAreValid = true;
      if (Object.hasOwn(candidate, "resources")) {
        const requests = candidate["resources"];
        if (!Array.isArray(requests)) {
          requestedResourcesAreValid = false;
        } else {
          const seen = new Set<string>();
          for (const resourceId of requests) {
            if (typeof resourceId !== "string" || resourceId.length === 0) {
              requestedResourcesAreValid = false;
              continue;
            }
            requestedResources.push(resourceId);
            if (seen.has(resourceId)) {
              errors.push({
                code: "DUPLICATE_RESOURCE",
                nodeId,
                resourceId,
              });
            }
            seen.add(resourceId);
          }
        }
      }
      if (!requestedResourcesAreValid) {
        errors.push({ code: "INVALID_NODE", nodeId, property: "resources" });
      }

      if (
        executorIsValid &&
        dependsOnIsValid &&
        configIsValid &&
        kindIsValid &&
        requestedResourcesAreValid &&
        (!hasWhen || parsedWhen !== undefined)
      ) {
        parsedNodes[nodeId] = {
          executor,
          dependsOn,
          ...(hasKind ? { kind: kind as NodeKind } : {}),
          ...(Object.hasOwn(candidate, "resources")
            ? { resources: requestedResources }
            : {}),
          ...(hasConfig ? { config: config as JsonValue } : {}),
          ...(parsedWhen === undefined ? {} : { when: parsedWhen }),
        };
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
    graph: {
      version: input["version"] as 1 | 2,
      ...(Object.hasOwn(input, "resources") && resourcesAreValid
        ? { resources: parsedResources }
        : {}),
      nodes: parsedNodes,
      ...(hasFinalNode ? { finalNode: finalNode as string } : {}),
    },
  };
}

function parseCondition(
  value: unknown,
  nodeId: string,
  path: string,
  errors: GraphParseError[],
): ExecutionCondition | undefined {
  const invalid = (): undefined => {
    errors.push({ code: "INVALID_CONDITION", nodeId, path });
    return undefined;
  };
  if (!isPlainObject(value)) return invalid();
  const keys = Object.keys(value);
  const combinator = keys.find(
    (key) => key === "all" || key === "any" || key === "not",
  );
  if (combinator !== undefined) {
    if (keys.length !== 1) return invalid();
    if (combinator === "not") {
      const nested = parseCondition(
        value["not"],
        nodeId,
        `${path}.not`,
        errors,
      );
      return nested === undefined ? undefined : { not: nested };
    }
    const children = value[combinator];
    if (!Array.isArray(children) || children.length === 0) return invalid();
    const parsed = children.map((child, index) =>
      parseCondition(
        child,
        nodeId,
        `${path}.${combinator}[${String(index)}]`,
        errors,
      ),
    );
    return parsed.some((child) => child === undefined)
      ? undefined
      : combinator === "all"
        ? { all: parsed as ExecutionCondition[] }
        : { any: parsed as ExecutionCondition[] };
  }
  const predicate = value["predicate"];
  if (
    typeof predicate !== "string" ||
    keys.some(
      (key) => key !== "predicate" && key !== "matches" && key !== "equals",
    )
  )
    return invalid();
  if (predicate === "changed_path") {
    return typeof value["matches"] === "string" &&
      value["matches"].length > 0 &&
      keys.length === 2
      ? { predicate, matches: value["matches"] }
      : invalid();
  }
  if (predicate === "diff_present" || predicate === "unresolved_risk") {
    return typeof value["equals"] === "boolean" && keys.length === 2
      ? { predicate, equals: value["equals"] }
      : invalid();
  }
  if (predicate === "validation_status") {
    return (value["equals"] === "passed" || value["equals"] === "failed") &&
      keys.length === 2
      ? { predicate, equals: value["equals"] }
      : invalid();
  }
  if (predicate === "review_status") {
    return (value["equals"] === "approved" ||
      value["equals"] === "changes_requested") &&
      keys.length === 2
      ? { predicate, equals: value["equals"] }
      : invalid();
  }
  return invalid();
}
