import { compileGraph } from "../graph/compile.js";
import type { GraphDefinition, JsonValue, NodeDefinition } from "../graph/types.js";
import type { RunStore } from "./ports.js";

/** A proposed append-only change to a running graph. */
export interface GraphExpansionProposal {
  /** Caller supplied idempotency key. Replaying this id never appends twice. */
  readonly id: string;
  /** Node/executor/operator identity retained in the durable audit record. */
  readonly proposer: string;
  /** New nodes only. Existing node definitions are never editable. */
  readonly nodes: Readonly<Record<string, NodeDefinition>>;
  /** Optional replacement final node. It must name an existing or added node. */
  readonly finalNode?: string;
  /** Opaque, JSON-safe context explaining why the expansion was requested. */
  readonly rationale?: JsonValue;
}

export type GraphProposalDecision =
  | { readonly status: "accepted"; readonly policy: string }
  | { readonly status: "rejected"; readonly policy: string; readonly reason: string };

/** Persisted decision. `graph` exists only for accepted decisions. */
export interface GraphRevision {
  readonly sequence: number;
  readonly graphRevision: number;
  readonly timestampMs: number;
  readonly proposal: GraphExpansionProposal;
  readonly decision: GraphProposalDecision;
  readonly addedNodeIds: readonly string[];
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
    rejection = error instanceof Error ? error.message : "invalid graph proposal";
  }
  const decision = rejection === undefined
    ? await policy(proposal, { runId, graphRevision: run.graphRevision })
    : { status: "rejected" as const, policy: "graph-validation", reason: rejection };

  const revision: GraphRevision = {
    sequence: -1,
    graphRevision: decision.status === "accepted" ? run.graphRevision + 1 : run.graphRevision,
    timestampMs: 0,
    proposal,
    decision,
    addedNodeIds: Object.keys(proposal.nodes).sort(),
    ...(decision.status === "accepted" && candidate !== undefined ? { graph: candidate } : {}),
  };
  const persisted = await store.appendGraphRevision(runId, revision, run.graphRevision);
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
  const nodes: Record<string, NodeDefinition> = Object.create(null);
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
    throw new Error(`graph proposal rejected by compiler: ${compiled.errors.map((e) => e.code).join(", ")}`);
  }
  return compiled.graph;
}
