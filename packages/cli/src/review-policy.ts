import {
  compileGraph,
  type CompiledGraph,
  type GraphDefinition,
  type JsonValue,
  type NodeDefinition,
} from "@rsetia/prism";

export interface AppliedGreptileAppSlug {
  readonly graph: CompiledGraph;
  readonly nodeIds: readonly string[];
}

/**
 * Apply one Greptile GitHub App identity to every Greptile-gated node
 * (implement and finalize_pr). Recompiling returns the same deeply frozen
 * shape that graph loading does, and lets the run store persist the
 * effective policy for later resumes.
 */
export function applyGreptileAppSlug(
  graph: CompiledGraph,
  requestedSlug: string,
): AppliedGreptileAppSlug {
  const greptileAppSlug = requestedSlug.trim();
  if (greptileAppSlug.length === 0) {
    throw new Error("Greptile app slug must be a non-empty string");
  }

  const nodes: Record<string, NodeDefinition> = Object.create(null) as Record<
    string,
    NodeDefinition
  >;
  const nodeIds: string[] = [];

  for (const nodeId of graph.order) {
    const node = graph.nodes[nodeId];
    if (node === undefined) {
      throw new Error(
        `compiled graph is missing node ${JSON.stringify(nodeId)}`,
      );
    }

    let config = node.config;
    if (
      (node.executor === "implement" || node.executor === "finalize_pr") &&
      isJsonObject(config)
    ) {
      const review = config["review"];
      if (isJsonObject(review) && review["by"] === "greptile") {
        const configuredSlug = review["greptileAppSlug"];
        if (configuredSlug !== undefined) {
          if (
            typeof configuredSlug !== "string" ||
            configuredSlug.trim().length === 0
          ) {
            throw new Error(
              `Greptile ${node.executor} node ${JSON.stringify(nodeId)} has an invalid review.greptileAppSlug`,
            );
          }
          if (configuredSlug.trim() !== greptileAppSlug) {
            throw new Error(
              `Greptile ${node.executor} node ${JSON.stringify(nodeId)} already selects app slug ${JSON.stringify(configuredSlug.trim())}, which conflicts with ${JSON.stringify(greptileAppSlug)}`,
            );
          }
        }

        config = {
          ...config,
          review: {
            ...review,
            greptileAppSlug,
          },
        };
        nodeIds.push(nodeId);
      }
    }

    nodes[nodeId] = {
      executor: node.executor,
      kind: node.kind,
      dependsOn: node.dependsOn,
      ...(node.resources.length === 0 ? {} : { resources: node.resources }),
      ...(config === undefined ? {} : { config }),
      ...(node.when === undefined ? {} : { when: node.when }),
    };
  }

  if (nodeIds.length === 0) {
    throw new Error("graph has no Greptile review nodes");
  }

  const definition: GraphDefinition = {
    version: graph.version,
    resources: graph.resources,
    nodes,
    finalNode: graph.finalNode,
  };
  const compiled = compileGraph(definition);
  if (!compiled.ok) {
    throw new Error(
      `could not recompile graph after applying Greptile app slug: ${JSON.stringify(compiled.errors)}`,
    );
  }

  return Object.freeze({
    graph: compiled.graph,
    nodeIds: Object.freeze(nodeIds),
  });
}

function isJsonObject(
  value: JsonValue | undefined,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
