import { compileGraph } from "../graph/compile.js";
import type {
  GraphDefinition,
  JsonValue,
  NodeDefinition,
} from "../graph/types.js";
import { isPlainObject } from "../internal/json.js";
import type { RunLease, RunStore } from "./ports.js";

/** A proposed append-only change to a running graph. */
export interface GraphExpansionProposal {
  /** Caller supplied idempotency key. Replaying this id never appends twice. */
  readonly id: string;
  /** Node/executor/operator identity retained in the durable audit record. */
  readonly proposer: string;
  /**
   * New nodes only. Existing node definitions are never editable through an
   * expansion; an operator refresh (below) is the one sanctioned exception.
   */
  readonly nodes: Readonly<Record<string, NodeDefinition>>;
  /** Optional replacement final node. It must name an existing or added node. */
  readonly finalNode?: string;
  /** Opaque, JSON-safe context explaining why the expansion was requested. */
  readonly rationale?: JsonValue;
  /**
   * Present only on operator refresh revisions (`rerun-node --refresh`):
   * the re-snapshotted configs that replaced existing nodes' frozen input.
   * Refresh revisions add no nodes (`nodes` is empty).
   */
  readonly refresh?: GraphRefresh;
}

/**
 * An operator re-snapshot of a node's frozen input (plan §16,
 * `rerun-node --refresh`). Only the listed nodes' `config` changes; ids,
 * dependencies, executors, kinds, resources and conditions stay identical.
 */
export interface GraphRefresh {
  /** The node the operator targeted (for example an implement node). */
  readonly targetNodeId: string;
  /**
   * Replacement configs. Allowed keys: the target, and direct dependencies
   * of the target whose only dependent is the target (its context node).
   */
  readonly configs: Readonly<Record<string, JsonValue>>;
  /** Audit context, e.g. `{ workItemId, specSource }`. */
  readonly source?: JsonValue;
}

export type GraphProposalDecision =
  | { readonly status: "accepted"; readonly policy: string }
  | {
      readonly status: "rejected";
      readonly policy: string;
      readonly reason: string;
    };

/** Persisted decision. `graph` exists only for accepted decisions. */
export interface GraphRevision {
  readonly sequence: number;
  readonly graphRevision: number;
  readonly timestampMs: number;
  readonly proposal: GraphExpansionProposal;
  readonly decision: GraphProposalDecision;
  readonly addedNodeIds: readonly string[];
  /** Nodes whose frozen config a refresh revision replaced (graph order). */
  readonly refreshedNodeIds?: readonly string[];
  readonly graph?: import("../graph/types.js").CompiledGraph;
}

export type GraphProposalPolicy = (
  proposal: GraphExpansionProposal,
  context: { readonly runId: string; readonly graphRevision: number },
) => GraphProposalDecision | Promise<GraphProposalDecision>;

export type GraphProposalResult =
  | { readonly status: "accepted"; readonly revision: GraphRevision }
  | { readonly status: "rejected"; readonly revision: GraphRevision };

/**
 * Validates and durably decides a proposal. The only mutation path is the
 * RunStore's atomic appendGraphRevision operation; executors receive this
 * function (not the store), so they cannot mutate scheduler state invisibly.
 */
export async function submitGraphProposal(
  store: RunStore,
  runId: string,
  proposal: GraphExpansionProposal,
  policy: GraphProposalPolicy,
  lease: RunLease,
): Promise<GraphProposalResult> {
  validateProposalShape(proposal);
  if (
    store.appendGraphRevision === undefined ||
    store.listGraphRevisions === undefined
  ) {
    throw new Error("run store does not support audited graph revisions");
  }
  const run = await store.getRun(runId);
  if (run === undefined) throw new Error(`unknown run: "${runId}"`);

  const prior = (await store.listGraphRevisions(runId)).find(
    (entry) => entry.proposal.id === proposal.id,
  );
  if (prior !== undefined) return resultFor(prior);

  let candidate: import("../graph/types.js").CompiledGraph | undefined;
  let rejection: string | undefined;
  try {
    candidate = compileExpansion(run.graph, proposal);
  } catch (error: unknown) {
    rejection =
      error instanceof Error ? error.message : "invalid graph proposal";
  }
  const decision =
    rejection === undefined
      ? await policy(proposal, { runId, graphRevision: run.graphRevision })
      : {
          status: "rejected" as const,
          policy: "graph-validation",
          reason: rejection,
        };

  const revision: GraphRevision = {
    sequence: -1,
    graphRevision:
      decision.status === "accepted"
        ? run.graphRevision + 1
        : run.graphRevision,
    timestampMs: 0,
    proposal,
    decision,
    addedNodeIds: Object.keys(proposal.nodes).sort(),
    ...(decision.status === "accepted" && candidate !== undefined
      ? { graph: candidate }
      : {}),
  };
  const persisted = await store.appendGraphRevision(
    runId,
    revision,
    run.graphRevision,
    lease,
  );
  return resultFor(persisted);
}

function resultFor(revision: GraphRevision): GraphProposalResult {
  return revision.decision.status === "accepted"
    ? { status: "accepted", revision }
    : { status: "rejected", revision };
}

function validateProposalShape(proposal: GraphExpansionProposal): void {
  if (proposal.id.length === 0 || proposal.proposer.length === 0) {
    throw new Error("graph proposal id and proposer must be non-empty");
  }
  if (Object.keys(proposal.nodes).length === 0) {
    throw new Error("graph proposal must add at least one node");
  }
}

function compileExpansion(
  graph: import("../graph/types.js").CompiledGraph,
  proposal: GraphExpansionProposal,
): import("../graph/types.js").CompiledGraph {
  const nodes: Record<string, NodeDefinition> = {};
  for (const nodeId of graph.order) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    nodes[nodeId] = {
      executor: node.executor,
      dependsOn: node.dependsOn,
      kind: node.kind,
      resources: node.resources,
      ...(node.config === undefined ? {} : { config: node.config }),
      ...(node.when === undefined ? {} : { when: node.when }),
    };
  }
  for (const [nodeId, node] of Object.entries(proposal.nodes)) {
    if (nodes[nodeId] !== undefined) {
      throw new Error(`graph proposal cannot modify existing node "${nodeId}"`);
    }
    nodes[nodeId] = node;
  }
  const definition: GraphDefinition = {
    version: graph.version,
    resources: graph.resources,
    nodes,
    finalNode: proposal.finalNode ?? graph.finalNode,
  };
  const compiled = compileGraph(definition);
  if (!compiled.ok) {
    throw new Error(
      `graph proposal rejected by compiler: ${compiled.errors.map((e) => e.code).join(", ")}`,
    );
  }
  return compiled.graph;
}

/**
 * Compile a refresh (pure): replace only the listed nodes' `config` and
 * prove nothing structural moved. Throws with an operator-facing reason
 * when the refresh is not allowed:
 * - a refreshed node is unknown, or is neither the target nor a direct
 *   dependency of the target whose only dependent is the target;
 * - a work item identity changes (`workItem.id`/`workItem.provider` on a
 *   task config, or `value.id` on a constant context config);
 * - any implement/task setting other than the work item changes (review,
 *   target branch, validation, branch name, ...);
 * - the recompiled graph's ids, order, dependencies, executors, kinds,
 *   resources or conditions differ.
 */
export function compileRefresh(
  graph: import("../graph/types.js").CompiledGraph,
  refresh: GraphRefresh,
): {
  readonly graph: import("../graph/types.js").CompiledGraph;
  readonly refreshedNodeIds: readonly string[];
} {
  const target = graph.nodes[refresh.targetNodeId];
  if (target === undefined) {
    throw new Error(`unknown node "${refresh.targetNodeId}"`);
  }
  const keys = Object.keys(refresh.configs);
  if (!keys.includes(refresh.targetNodeId)) {
    throw new Error(
      `refresh must replace the target node "${refresh.targetNodeId}"`,
    );
  }
  for (const nodeId of keys) {
    const node = graph.nodes[nodeId];
    if (node === undefined) {
      throw new Error(`refresh names unknown node "${nodeId}"`);
    }
    if (nodeId === refresh.targetNodeId) continue;
    const isOwnedInput =
      target.dependsOn.includes(nodeId) &&
      node.dependents.length === 1 &&
      node.dependents[0] === refresh.targetNodeId;
    if (!isOwnedInput) {
      throw new Error(
        `refresh may only replace "${refresh.targetNodeId}" and inputs only it consumes; "${nodeId}" is not one`,
      );
    }
  }
  for (const nodeId of keys) {
    assertSameIdentity(
      nodeId,
      graph.nodes[nodeId]?.config,
      refresh.configs[nodeId],
    );
  }

  const nodes: Record<string, NodeDefinition> = {};
  for (const nodeId of graph.order) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    const config = Object.hasOwn(refresh.configs, nodeId)
      ? refresh.configs[nodeId]
      : node.config;
    nodes[nodeId] = {
      executor: node.executor,
      dependsOn: node.dependsOn,
      kind: node.kind,
      resources: node.resources,
      ...(config === undefined ? {} : { config }),
      ...(node.when === undefined ? {} : { when: node.when }),
    };
  }
  const compiled = compileGraph({
    version: graph.version,
    resources: graph.resources,
    nodes,
    finalNode: graph.finalNode,
  });
  if (!compiled.ok) {
    throw new Error(
      `refresh rejected by compiler: ${compiled.errors.map((e) => e.code).join(", ")}`,
    );
  }
  const next = compiled.graph;
  if (
    stableJson(next.order) !== stableJson(graph.order) ||
    next.finalNode !== graph.finalNode ||
    stableJson(next.resources) !== stableJson(graph.resources)
  ) {
    throw new Error("refresh would change the graph structure");
  }
  for (const nodeId of graph.order) {
    const before = graph.nodes[nodeId];
    const after = next.nodes[nodeId];
    if (
      before === undefined ||
      after === undefined ||
      before.executor !== after.executor ||
      before.kind !== after.kind ||
      stableJson(before.dependsOn) !== stableJson(after.dependsOn) ||
      stableJson(before.dependents) !== stableJson(after.dependents) ||
      stableJson(before.resources) !== stableJson(after.resources) ||
      stableJson(before.when ?? null) !== stableJson(after.when ?? null)
    ) {
      throw new Error(`refresh would change the structure of node "${nodeId}"`);
    }
  }
  return {
    graph: next,
    refreshedNodeIds: graph.order.filter((nodeId) => keys.includes(nodeId)),
  };
}

/**
 * Build the audited, accepted revision for a refresh (pure). The store
 * assigns `sequence`, `graphRevision` and `timestampMs` when persisting.
 */
export function buildRefreshRevision(
  graph: import("../graph/types.js").CompiledGraph,
  refresh: GraphRefresh,
  options: { readonly id: string; readonly proposer: string },
): GraphRevision {
  const compiled = compileRefresh(graph, refresh);
  return {
    sequence: -1,
    graphRevision: -1,
    timestampMs: 0,
    proposal: {
      id: options.id,
      proposer: options.proposer,
      nodes: {},
      refresh,
      ...(refresh.source === undefined ? {} : { rationale: refresh.source }),
    },
    decision: { status: "accepted", policy: "operator-refresh" },
    addedNodeIds: [],
    refreshedNodeIds: compiled.refreshedNodeIds,
    graph: compiled.graph,
  };
}

/** Whether a revision is an operator refresh (vs. an expansion). */
export function isRefreshRevision(revision: GraphRevision): boolean {
  return revision.proposal.refresh !== undefined;
}

function assertSameIdentity(
  nodeId: string,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): void {
  if (after === undefined) {
    throw new Error(`refresh config for "${nodeId}" is missing`);
  }
  const previous = isPlainObject(before) ? before : undefined;
  const replacement = isPlainObject(after) ? after : undefined;
  const previousItem = isPlainObject(previous?.["workItem"])
    ? previous["workItem"]
    : undefined;
  if (previousItem !== undefined) {
    const nextItem = isPlainObject(replacement?.["workItem"])
      ? replacement["workItem"]
      : undefined;
    if (
      nextItem === undefined ||
      nextItem["id"] !== previousItem["id"] ||
      nextItem["provider"] !== previousItem["provider"]
    ) {
      throw new Error(
        `refreshed work item for "${nodeId}" is ${describeItem(nextItem)}, expected ${describeItem(previousItem)}`,
      );
    }
    // Everything but the work item snapshot is a run setting (review gate,
    // target branch, branch name, validation, iterations) and must not move.
    const settings = (value: Record<string, unknown> | undefined) =>
      stableJson(
        Object.fromEntries(
          Object.entries(value ?? {}).filter(([key]) => key !== "workItem"),
        ),
      );
    if (settings(previous) !== settings(replacement)) {
      throw new Error(
        `refresh may only change the work item of "${nodeId}"; its settings must stay unchanged`,
      );
    }
    return;
  }
  const previousValue = isPlainObject(previous?.["value"])
    ? previous["value"]
    : undefined;
  if (previousValue !== undefined && previousValue["id"] !== undefined) {
    const nextValue = isPlainObject(replacement?.["value"])
      ? replacement["value"]
      : undefined;
    if (nextValue?.["id"] !== previousValue["id"]) {
      throw new Error(
        `refreshed context for "${nodeId}" is for ${JSON.stringify(nextValue?.["id"] ?? null)}, expected ${JSON.stringify(previousValue["id"])}`,
      );
    }
  }
}

function describeItem(item: Record<string, unknown> | undefined): string {
  if (item === undefined) return "missing";
  const part = (value: unknown): string =>
    typeof value === "string" ? value : JSON.stringify(value ?? "?");
  return `${part(item["provider"])}:${part(item["id"])}`;
}

/** Key-order-independent JSON for structural comparison. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    isPlainObject(nested)
      ? Object.fromEntries(
          Object.keys(nested)
            .sort()
            .map((key) => [key, nested[key]]),
        )
      : nested,
  );
}
