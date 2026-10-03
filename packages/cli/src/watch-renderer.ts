import { describeFailure } from "@rsetia/prism";
import type { CompiledGraph, NodeState, RunInspection } from "@rsetia/prism";

export interface WatchDashboardOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly color?: boolean;
  readonly frame?: number;
  /** Wall-clock time for relative ages in the poll panel. Default Date.now(). */
  readonly nowMs?: number;
}

const RESET = "\u001B[0m";
const DIM = "\u001B[2m";
const BOLD = "\u001B[1m";
const CYAN = "\u001B[1;36m";
const MAGENTA = "\u001B[1;35m";
const YELLOW = "\u001B[1;33m";
const SPINNERS = ["◐", "◓", "◑", "◒"] as const;
const TERMINAL_STATES: ReadonlySet<NodeState> = new Set([
  "succeeded",
  "failed",
  "blocked",
  "skipped",
  "cancelled",
]);

interface StatePresentation {
  readonly symbol: string;
  readonly style: string;
}

const STATE_PRESENTATION: Readonly<Record<NodeState, StatePresentation>> = {
  pending: { symbol: "○", style: DIM },
  ready: { symbol: "◇", style: "\u001B[1;33m" },
  resource_wait: { symbol: "⌛", style: "\u001B[1;33m" },
  running: { symbol: "▶", style: "\u001B[1;30;46m" },
  succeeded: { symbol: "✓", style: "\u001B[1;32m" },
  failed: { symbol: "✕", style: "\u001B[1;37;41m" },
  blocked: { symbol: "⊘", style: "\u001B[1;35m" },
  skipped: { symbol: "↷", style: DIM },
  cancelling: { symbol: "◌", style: "\u001B[1;33m" },
  cancelled: { symbol: "—", style: DIM },
  retry_wait: { symbol: "↻", style: "\u001B[1;33m" },
};

/** A failed node waiting on the operator rather than broken (needs_input). */
const NEEDS_INPUT_PRESENTATION: StatePresentation = {
  symbol: "⏸",
  style: "\u001B[1;30;43m",
};

function presentationFor(
  state: NodeState,
  nodeId: string,
  needsInput: ReadonlySet<string>,
): StatePresentation {
  return state === "failed" && needsInput.has(nodeId)
    ? NEEDS_INPUT_PRESENTATION
    : STATE_PRESENTATION[state];
}

interface WorkflowStage {
  readonly nodeId: string;
  readonly label: string;
}

interface BeadsWorkflow {
  readonly id: string;
  readonly title: string;
  readonly stages: readonly WorkflowStage[];
  readonly dependencyIds: readonly string[];
  readonly depth: number;
}

interface WorkflowRuntimeWait {
  readonly stageLabel: string;
  readonly blockerLabels: readonly string[];
}

export function renderWatchDashboard(
  graph: CompiledGraph,
  inspection: RunInspection,
  options: WatchDashboardOptions = {},
): string {
  const columns = clamp(options.columns ?? 100, 50, 180);
  const color = options.color ?? true;
  const frame = options.frame ?? 0;
  const stateByNode = new Map(
    inspection.nodes.map((node) => [node.nodeId, node.state]),
  );
  const needsInput = new Set(
    inspection.failures
      .map((failure) =>
        describeFailure(failure, {
          runId: inspection.runId,
          finished: inspection.finished,
        }),
      )
      .filter((detail) => detail.disposition === "needs_input")
      .map((detail) => detail.nodeId),
  );
  const counts = countStates(inspection);
  const lines = renderHeader(inspection, counts, columns, color, frame);
  const workflows = extractBeadsWorkflows(graph);
  const pollPanel = renderPollPanel(
    graph,
    inspection,
    stateByNode,
    columns,
    color,
    options.nowMs ?? Date.now(),
  );
  lines.push(...pollPanel);

  if (workflows.length > 0) {
    lines.push(
      ...renderBeadsDag(
        graph,
        workflows,
        stateByNode,
        columns,
        color,
        needsInput,
      ),
    );
  } else if (pollPanel.length > 0) {
    lines.push(
      style(
        truncate(
          "◆ NO WORK ITEMS YET · matching items appear here as they are queued",
          columns,
        ),
        DIM,
        color,
      ),
    );
  } else {
    lines.push(
      ...renderGenericDag(graph, stateByNode, columns, color, needsInput),
    );
  }

  appendFooter(lines, inspection, columns, options.rows, color);
  return lines.join("\n");
}

function renderHeader(
  inspection: RunInspection,
  counts: Readonly<Record<NodeState, number>>,
  columns: number,
  color: boolean,
  frame: number,
): string[] {
  const settled = inspection.nodes.filter((node) =>
    TERMINAL_STATES.has(node.state),
  ).length;
  const issues = counts.failed + counts.blocked + counts.cancelled;
  const active = counts.running + counts.cancelling;
  const queued =
    counts.pending + counts.ready + counts.resource_wait + counts.retry_wait;
  const runStatus = inspection.finished
    ? issues > 0
      ? "FAILED"
      : "COMPLETE"
    : "RUNNING";
  const spinner = inspection.finished
    ? runStatus === "COMPLETE"
      ? "◆"
      : "!"
    : (SPINNERS[frame % SPINNERS.length] ?? "◐");
  const statusStyle =
    runStatus === "FAILED"
      ? "\u001B[1;31m"
      : runStatus === "COMPLETE"
        ? "\u001B[1;32m"
        : CYAN;
  const brand = "◆ PRISM // LIVE DAG";
  const status = `${spinner} ${runStatus}`;
  const titleFill = "─".repeat(
    Math.max(1, columns - brand.length - status.length - 8),
  );
  const title = `╭─ ${brand} ${titleFill} ${status} ─╮`;
  const innerWidth = columns - 4;
  const runLine = leftRight(
    `RUN ${inspection.runId}`,
    `${String(inspection.nodes.length)} NODES`,
    innerWidth,
  );
  const barWidth = clamp(Math.floor(columns / 6), 10, 18);
  const progress = progressBar(settled, inspection.nodes.length, barWidth);
  const percent =
    inspection.nodes.length === 0
      ? 100
      : Math.round((settled / inspection.nodes.length) * 100);
  const summary =
    columns >= 72
      ? `${String(percent)}% · ${String(settled)}/${String(inspection.nodes.length)} · ${String(active)} ACTIVE · ${String(queued)} QUEUED · ${String(issues)} ISSUES`
      : `${String(percent)}% · ${String(active)} ACTIVE · ${String(issues)} ISSUES`;
  return [
    style(title, statusStyle, color),
    panelRow(runLine, columns, color, DIM),
    panelRow(
      leftRight(progress, summary, innerWidth),
      columns,
      color,
      statusStyle,
    ),
    style(`╰${"─".repeat(columns - 2)}╯`, DIM, color),
  ];
}

function extractBeadsWorkflows(graph: CompiledGraph): readonly BeadsWorkflow[] {
  interface WorkflowDraft {
    readonly id: string;
    readonly title: string;
    readonly implementationNodeId: string;
    readonly stages: readonly WorkflowStage[];
    readonly contextDependencies: readonly string[];
  }

  const drafts: WorkflowDraft[] = [];
  const implementationToId = new Map<string, string>();

  for (const nodeId of graph.order) {
    const node = graph.nodes[nodeId];
    if (node?.executor !== "implement") continue;
    const workItem = objectValue(objectValue(node.config)?.["workItem"]);
    // Any work-item provider with a frozen context snapshot gets a lane:
    // Beads items, and items a poll node queued (Linear issues).
    const provider = workItem?.["provider"];
    if (
      typeof provider !== "string" ||
      provider === "prism" ||
      typeof workItem?.["id"] !== "string"
    ) {
      continue;
    }

    const id = workItem["id"];
    const contextNodeId = node.dependsOn.find((dependencyId) => {
      const value = objectValue(
        objectValue(graph.nodes[dependencyId]?.config)?.["value"],
      );
      return value?.["provider"] === provider && value["id"] === id;
    });
    const contextValue =
      contextNodeId === undefined
        ? undefined
        : objectValue(
            objectValue(graph.nodes[contextNodeId]?.config)?.["value"],
          );
    const mergeNodeId = graph.order.find((candidateId) => {
      const candidate = graph.nodes[candidateId];
      return (
        candidate?.executor === "merge_resolve" &&
        objectValue(candidate.config)?.["sourceBranchFrom"] === nodeId
      );
    });
    const updateNodeId = graph.order.find((candidateId) => {
      const candidate = graph.nodes[candidateId];
      return (
        candidate?.executor === "beads_update" &&
        objectValue(candidate.config)?.["beadId"] === id
      );
    });
    const stages: WorkflowStage[] = [];
    if (contextNodeId !== undefined) {
      stages.push({ nodeId: contextNodeId, label: "CONTEXT" });
    }
    stages.push({ nodeId, label: "BUILD" });
    if (mergeNodeId !== undefined) {
      stages.push({ nodeId: mergeNodeId, label: "MERGE" });
    }
    if (updateNodeId !== undefined) {
      stages.push({ nodeId: updateNodeId, label: "CLOSE" });
    }
    const metadataDependencies = contextValue?.["dependencies"];
    const contextDependencies = Array.isArray(metadataDependencies)
      ? metadataDependencies.filter(
          (dependency): dependency is string => typeof dependency === "string",
        )
      : [];
    const title =
      typeof workItem["title"] === "string"
        ? workItem["title"]
        : typeof contextValue?.["title"] === "string"
          ? contextValue["title"]
          : id;

    drafts.push({
      id,
      title,
      implementationNodeId: nodeId,
      stages,
      contextDependencies,
    });
    implementationToId.set(nodeId, id);
  }

  if (drafts.length === 0) return [];

  const knownIds = new Set(drafts.map((draft) => draft.id));
  const dependencyIdsByWorkflow = new Map<string, readonly string[]>();
  for (const draft of drafts) {
    let dependencyIds = draft.contextDependencies.filter((id) =>
      knownIds.has(id),
    );
    if (dependencyIds.length === 0) {
      const implementationNode = graph.nodes[draft.implementationNodeId];
      dependencyIds =
        implementationNode?.dependsOn.flatMap((dependencyNodeId) => {
          const directId = implementationToId.get(dependencyNodeId);
          if (directId !== undefined) return [directId];
          const sourceBranchFrom = objectValue(
            graph.nodes[dependencyNodeId]?.config,
          )?.["sourceBranchFrom"];
          if (typeof sourceBranchFrom !== "string") return [];
          const mergedId = implementationToId.get(sourceBranchFrom);
          return mergedId === undefined ? [] : [mergedId];
        }) ?? [];
    }
    dependencyIdsByWorkflow.set(
      draft.id,
      unique(dependencyIds.filter((id) => id !== draft.id)),
    );
  }

  const depthById = new Map<string, number>();
  return drafts.map((draft) => {
    const dependencyIds = dependencyIdsByWorkflow.get(draft.id) ?? [];
    const depth =
      dependencyIds.length === 0
        ? 0
        : Math.max(
            ...dependencyIds.map(
              (dependencyId) => depthById.get(dependencyId) ?? 0,
            ),
          ) + 1;
    depthById.set(draft.id, depth);
    return {
      id: draft.id,
      title: draft.title,
      stages: draft.stages,
      dependencyIds,
      depth,
    };
  });
}

function renderBeadsDag(
  graph: CompiledGraph,
  workflows: readonly BeadsWorkflow[],
  stateByNode: ReadonlyMap<string, NodeState>,
  columns: number,
  color: boolean,
  needsInput: ReadonlySet<string>,
): string[] {
  const waveCount =
    Math.max(...workflows.map((workflow) => workflow.depth)) + 1;
  const namespace = sharedNamespace(workflows.map((workflow) => workflow.id));
  const displayId = (id: string): string =>
    namespace.length > 0 && id.startsWith(namespace)
      ? id.slice(namespace.length)
      : id;
  const displayIds = workflows.map((workflow) => displayId(workflow.id));
  const idWidth = clamp(Math.max(...displayIds.map((id) => id.length)), 5, 16);
  const stageOwnerByNode = new Map(
    workflows.flatMap((workflow) =>
      workflow.stages.map(
        (stage) =>
          [
            stage.nodeId,
            { workflowId: workflow.id, stageLabel: stage.label },
          ] as const,
      ),
    ),
  );
  const stageLabels = workflows.reduce<readonly WorkflowStage[]>(
    (longest, workflow) =>
      workflow.stages.length > longest.length ? workflow.stages : longest,
    [],
  );
  const stageLegend =
    columns >= 64
      ? stageLabels.map((stage) => stage.label).join(" › ")
      : stageLabels
          .map((stage) => (stage.label === "CONTEXT" ? "CTX" : stage.label))
          .join(" › ");
  const banner = leftRight(
    `◆ DAG · ${String(workflows.length)} WORK ITEMS · ${String(waveCount)} WAVES`,
    stageLegend,
    columns,
  );
  const lines = [style(banner, CYAN, color)];

  for (let depth = 0; depth < waveCount; depth += 1) {
    const wave = workflows
      .filter((workflow) => workflow.depth === depth)
      .sort((left, right) =>
        left.id.localeCompare(right.id, undefined, { numeric: true }),
      );
    const waveLabel =
      depth === 0
        ? `WAVE ${waveNumber(depth)} · ${String(wave.length)} PARALLEL ROOTS`
        : wave.length > 1
          ? `WAVE ${waveNumber(depth)} · ${String(wave.length)} PARALLEL`
          : `WAVE ${waveNumber(depth)} · 1 WORK ITEM`;
    lines.push(sectionRule(waveLabel, columns, color));
    for (const [index, workflow] of wave.entries()) {
      const runtimeWait = findWorkflowRuntimeWait(
        graph,
        workflow,
        stateByNode,
        stageOwnerByNode,
        displayId,
      );
      lines.push(
        renderWorkflowLane(
          workflow,
          index === wave.length - 1,
          displayId,
          idWidth,
          stateByNode,
          columns,
          color,
          runtimeWait,
          needsInput,
        ),
      );
    }
  }

  const coveredNodes = new Set(
    workflows.flatMap((workflow) =>
      workflow.stages.map((stage) => stage.nodeId),
    ),
  );
  // A poll run's final node is the poller itself; the poll panel shows it.
  if (
    !coveredNodes.has(graph.finalNode) &&
    graph.nodes[graph.finalNode]?.executor !== POLL_EXECUTOR
  ) {
    const state = stateByNode.get(graph.finalNode) ?? "pending";
    const presentation = STATE_PRESENTATION[state];
    lines.push(
      `${style("╰━━▶", CYAN, color)} ${style("◆ FINAL GATE", BOLD, color)}  ${style(presentation.symbol, presentation.style, color)} ${style(graph.finalNode, BOLD, color)}  ${style(`← ${String(workflows.length)} work items`, DIM, color)}`,
    );
  }
  return lines;
}

const POLL_EXECUTOR = "poll";
const POLL_PROPOSER_PREFIX = "poll:";
const POLL_IMPLEMENT_RESOURCE = "poll-implement";

/**
 * Poll mode: what is being watched, how often, and where queued items
 * stand. Items that finished their implementer passed the review gate and
 * are waiting for a human, so they read as "ready for review".
 */
function renderPollPanel(
  graph: CompiledGraph,
  inspection: RunInspection,
  stateByNode: ReadonlyMap<string, NodeState>,
  columns: number,
  color: boolean,
  nowMs: number,
): string[] {
  const pollNodeId = graph.order.find(
    (nodeId) => graph.nodes[nodeId]?.executor === POLL_EXECUTOR,
  );
  if (pollNodeId === undefined) return [];
  const config = objectValue(graph.nodes[pollNodeId]?.config);
  const source = objectValue(config?.["source"]);
  const kind = typeof source?.["kind"] === "string" ? source["kind"] : "source";
  const label =
    typeof source?.["label"] === "string" ? ` · label ${source["label"]}` : "";
  const intervalSeconds = config?.["intervalSeconds"];
  const cadence =
    typeof intervalSeconds === "number"
      ? ` · every ${formatInterval(intervalSeconds)}`
      : "";
  const pollState = stateByNode.get(pollNodeId) ?? "pending";
  const presentation = STATE_PRESENTATION[pollState];
  const status = `${presentation.symbol} ${
    pollState === "running" ? "POLLING" : pollState.toUpperCase()
  }`;

  const pollRevisions = (inspection.graphRevisions ?? []).filter((revision) =>
    revision.proposal.proposer.startsWith(POLL_PROPOSER_PREFIX),
  );
  const accepted = pollRevisions.filter(
    (revision) => revision.decision.status === "accepted",
  );
  const rejected = pollRevisions.length - accepted.length;
  const implementStates = graph.order
    .filter((nodeId) => {
      const node = graph.nodes[nodeId];
      return (
        node?.executor === "implement" &&
        node.resources.includes(POLL_IMPLEMENT_RESOURCE)
      );
    })
    .map((nodeId) => stateByNode.get(nodeId) ?? "pending");
  const tally = (states: readonly NodeState[]): number =>
    implementStates.filter((state) => states.includes(state)).length;
  const active = tally(["running", "cancelling"]);
  const waiting = tally(["pending", "ready", "resource_wait", "retry_wait"]);
  const ready = tally(["succeeded"]);
  const attention = tally(["failed", "blocked", "cancelled"]);
  const last = accepted.at(-1);
  const lastKey = objectValue(last?.proposal.rationale)?.["key"];
  const lastQueued =
    last === undefined
      ? ""
      : ` · last queued ${typeof lastKey === "string" ? `${lastKey} ` : ""}${formatAge(nowMs - last.timestampMs)}`;
  const summary = [
    `${String(accepted.length)} queued`,
    `${String(active)} active`,
    `${String(waiting)} waiting`,
    `${String(ready)} ready for review`,
    ...(attention > 0 ? [`${String(attention)} need attention`] : []),
    ...(rejected > 0 ? [`${String(rejected)} rejected`] : []),
  ].join(" · ");

  const brand = `◆ POLL · ${kind}`;
  const titleFill = "─".repeat(
    Math.max(1, columns - brand.length - status.length - 8),
  );
  const innerWidth = columns - 4;
  const statusStyle =
    pollState === "running"
      ? MAGENTA
      : pollState === "failed"
        ? "\u001B[1;31m"
        : YELLOW;
  return [
    style(`╭─ ${brand} ${titleFill} ${status} ─╮`, statusStyle, color),
    panelRow(
      truncate(`WATCHING ${kind}${label}${cadence}`, innerWidth),
      columns,
      color,
      DIM,
    ),
    panelRow(
      truncate(`${summary}${lastQueued}`, innerWidth),
      columns,
      color,
      statusStyle,
    ),
    style(`╰${"─".repeat(columns - 2)}╯`, DIM, color),
  ];
}

function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${String(seconds / 3600)}h`;
  if (seconds % 60 === 0) return `${String(seconds / 60)}m`;
  return `${String(seconds)}s`;
}

function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

function renderWorkflowLane(
  workflow: BeadsWorkflow,
  lastInWave: boolean,
  displayId: (id: string) => string,
  idWidth: number,
  stateByNode: ReadonlyMap<string, NodeState>,
  columns: number,
  color: boolean,
  runtimeWait: WorkflowRuntimeWait | undefined,
  needsInput: ReadonlySet<string>,
): string {
  const states = workflow.stages.map(
    (stage) => stateByNode.get(stage.nodeId) ?? "pending",
  );
  const workflowState = aggregateState(states);
  const waitingOnOperator =
    workflowState === "failed" &&
    workflow.stages.some(
      (stage) =>
        needsInput.has(stage.nodeId) &&
        stateByNode.get(stage.nodeId) === "failed",
    );
  const workflowPresentation = waitingOnOperator
    ? NEEDS_INPUT_PRESENTATION
    : STATE_PRESENTATION[workflowState];
  const rail = lastInWave ? "╰─" : "├─";
  const id = truncate(displayId(workflow.id), idWidth).padEnd(idWidth);
  const pipelineWidth = workflow.stages.length * 3 - 2;
  const prefixWidth = rail.length + 1 + 1 + 1 + idWidth + 2 + pipelineWidth;
  let detailBudget = Math.max(0, columns - prefixWidth - 2);
  const waitBudget =
    runtimeWait === undefined
      ? 0
      : Math.min(Math.max(18, Math.floor(columns * 0.3)), detailBudget);
  const waitPrefix =
    runtimeWait === undefined ? "" : `${runtimeWait.stageLabel} WAIT ← `;
  const waitDetail =
    runtimeWait === undefined || waitBudget < waitPrefix.length + 1
      ? ""
      : truncate(
          `${waitPrefix}${summarizeIds(
            runtimeWait.blockerLabels,
            waitBudget - waitPrefix.length,
          )}`,
          waitBudget,
        );
  if (waitDetail.length > 0) {
    detailBudget = Math.max(0, detailBudget - waitDetail.length - 2);
  }
  const dependencyBudget = clamp(Math.floor(columns * 0.28), 12, detailBudget);
  const dependencies =
    workflow.dependencyIds.length === 0 || dependencyBudget < 4
      ? ""
      : `← ${summarizeIds(
          workflow.dependencyIds.map(displayId),
          dependencyBudget - 2,
        )}`;
  if (dependencies.length > 0) {
    detailBudget = Math.max(0, detailBudget - dependencies.length - 2);
  }
  const titleBudget = detailBudget;
  const title = truncate(workflow.title, titleBudget);
  const pipeline = renderPipeline(workflow.stages, states, color, needsInput);

  return [
    style(rail, CYAN, color),
    " ",
    style(workflowPresentation.symbol, workflowPresentation.style, color),
    " ",
    style(id, BOLD, color),
    "  ",
    pipeline,
    waitDetail.length === 0 ? "" : `  ${style(waitDetail, YELLOW, color)}`,
    dependencies.length === 0 ? "" : `  ${style(dependencies, MAGENTA, color)}`,
    title.length === 0 ? "" : `  ${title}`,
  ].join("");
}

function findWorkflowRuntimeWait(
  graph: CompiledGraph,
  workflow: BeadsWorkflow,
  stateByNode: ReadonlyMap<string, NodeState>,
  stageOwnerByNode: ReadonlyMap<
    string,
    { readonly workflowId: string; readonly stageLabel: string }
  >,
  displayId: (id: string) => string,
): WorkflowRuntimeWait | undefined {
  const waitingStage = workflow.stages.find((stage) => {
    const state = stateByNode.get(stage.nodeId) ?? "pending";
    return state === "pending" || state === "resource_wait";
  });
  if (waitingStage === undefined) return undefined;

  const ownNodes = new Set(workflow.stages.map((stage) => stage.nodeId));
  const waitingNode = graph.nodes[waitingStage.nodeId];
  const resourceBlockers =
    (stateByNode.get(waitingStage.nodeId) ?? "pending") === "resource_wait"
      ? graph.order.filter((nodeId) => {
          const state = stateByNode.get(nodeId) ?? "pending";
          if (state !== "running" && state !== "cancelling") return false;
          const node = graph.nodes[nodeId];
          return (
            node?.resources.some((resourceId) =>
              waitingNode?.resources.includes(resourceId),
            ) === true
          );
        })
      : [];
  const dependencyBlockers =
    waitingNode?.dependsOn.filter(
      (dependencyId) =>
        !ownNodes.has(dependencyId) &&
        (stateByNode.get(dependencyId) ?? "pending") !== "succeeded",
    ) ?? [];
  const blockerNodeIds = unique([...resourceBlockers, ...dependencyBlockers]);
  if (blockerNodeIds.length === 0) return undefined;

  const blockerLabels = unique(
    blockerNodeIds.map((nodeId) => {
      const owner = stageOwnerByNode.get(nodeId);
      return owner === undefined
        ? nodeId
        : `${displayId(owner.workflowId)} ${owner.stageLabel}`;
    }),
  );
  return {
    stageLabel: waitingStage.label,
    blockerLabels,
  };
}

function renderPipeline(
  stages: readonly WorkflowStage[],
  states: readonly NodeState[],
  color: boolean,
  needsInput: ReadonlySet<string>,
): string {
  const parts: string[] = [];
  for (let index = 0; index < stages.length; index += 1) {
    const state = states[index] ?? "pending";
    if (index > 0) {
      const previous = states[index - 1] ?? "pending";
      parts.push(
        style(
          previous === "succeeded" ? "━━" : "──",
          previous === "succeeded" ? "\u001B[32m" : DIM,
          color,
        ),
      );
    }
    const presentation = presentationFor(
      state,
      stages[index]?.nodeId ?? "",
      needsInput,
    );
    parts.push(style(presentation.symbol, presentation.style, color));
  }
  return parts.join("");
}

function renderGenericDag(
  graph: CompiledGraph,
  stateByNode: ReadonlyMap<string, NodeState>,
  columns: number,
  color: boolean,
  needsInput: ReadonlySet<string>,
): string[] {
  const waves = buildWaves(graph);
  const lines = [
    style(
      leftRight(
        `◆ EXECUTION DAG · ${String(graph.order.length)} NODES`,
        `${String(waves.length)} WAVES`,
        columns,
      ),
      CYAN,
      color,
    ),
  ];
  for (const [waveIndex, wave] of waves.entries()) {
    const label =
      waveIndex === 0
        ? `${waveNumber(waveIndex)} ROOTS · ${String(wave.length)} PARALLEL`
        : `${waveNumber(waveIndex)} WAVE · ${String(wave.length)} ${plural("NODE", wave.length)}`;
    lines.push(sectionRule(label, columns, color));
    for (const [nodeIndex, nodeId] of wave.entries()) {
      const node = graph.nodes[nodeId];
      const state = stateByNode.get(nodeId) ?? "pending";
      const presentation = presentationFor(state, nodeId, needsInput);
      const dependency =
        node === undefined || node.dependsOn.length === 0
          ? ""
          : `  ${style(
              `← ${summarizeIds(node.dependsOn, Math.floor(columns / 3))}`,
              MAGENTA,
              color,
            )}`;
      const final = nodeId === graph.finalNode ? "  ◆ FINAL" : "";
      const plainReserved =
        6 +
        stripAnsi(dependency).length +
        final.length +
        (node?.executor.length ?? 0);
      const shownNodeId = truncate(nodeId, columns - plainReserved);
      lines.push(
        `${style(nodeIndex === wave.length - 1 ? "╰─" : "├─", CYAN, color)} ${style(presentation.symbol, presentation.style, color)} ${style(shownNodeId, BOLD, color)}${dependency}${style(final, CYAN, color)}${node === undefined ? "" : `  ${style(node.executor, DIM, color)}`}`,
      );
    }
  }
  return lines;
}

function buildWaves(graph: CompiledGraph): readonly (readonly string[])[] {
  const depthByNode = new Map<string, number>();
  const waves: string[][] = [];
  for (const nodeId of graph.order) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    const depth =
      node.dependsOn.length === 0
        ? 0
        : Math.max(
            ...node.dependsOn.map(
              (dependency) => depthByNode.get(dependency) ?? 0,
            ),
          ) + 1;
    depthByNode.set(nodeId, depth);
    const wave = waves[depth] ?? [];
    wave.push(nodeId);
    waves[depth] = wave;
  }
  return waves;
}

function appendFooter(
  lines: string[],
  inspection: RunInspection,
  columns: number,
  rows: number | undefined,
  color: boolean,
): void {
  // Operator refreshes re-wrote a node's frozen input mid-run; say so, so a
  // re-running node is never mistaken for a plain retry of stale input.
  const refreshes = (inspection.graphRevisions ?? []).filter(
    (revision) => revision.proposal.refresh !== undefined,
  );
  for (const revision of refreshes.slice(-3)) {
    const refresh = revision.proposal.refresh;
    const source = objectValue(refresh?.source);
    const item =
      typeof source?.["workItemId"] === "string"
        ? ` (${source["workItemId"]})`
        : "";
    lines.push(
      style(
        truncate(
          `↻ refreshed work item for ${refresh?.targetNodeId ?? "?"}${item} at ${new Date(revision.timestampMs).toISOString()}`,
          columns,
        ),
        DIM,
        color,
      ),
    );
  }
  if (inspection.failures.length === 0) {
    lines.push(
      style(
        truncate(
          "✓ done   ▶ running   ◇ ready   ○ queued   ↻ retry   ✕ failed   ⏸ needs input   ⊘ blocked",
          columns,
        ),
        DIM,
        color,
      ),
    );
    return;
  }

  const details = inspection.failures.map((failure) =>
    describeFailure(failure, {
      runId: inspection.runId,
      finished: inspection.finished,
    }),
  );
  // Blockers waiting on the operator come first and apart from failures:
  // they are not crashes, and they will not move until someone acts.
  const waiting = details.filter((d) => d.disposition === "needs_input");
  const failed = details.filter((d) => d.disposition !== "needs_input");
  const entries: { readonly text: string; readonly style: string }[] = [];
  for (const [index, detail] of waiting.entries()) {
    const prefix = index === 0 ? "Needs your input · " : "                   ";
    entries.push({
      text: `${prefix}⏸ ${detail.nodeId}: ${detail.summary}${detail.pullRequestUrl === undefined ? "" : ` · ${detail.pullRequestUrl}`}`,
      style: YELLOW,
    });
    entries.push({ text: `                     → ${detail.hint}`, style: DIM });
  }
  for (const [index, detail] of failed.entries()) {
    const prefix = index === 0 ? "Failures · " : "           ";
    entries.push({
      text: `${prefix}✕ ${detail.nodeId}: ${detail.summary}`,
      style: "\u001B[1;31m",
    });
    entries.push({ text: `             → ${detail.hint}`, style: DIM });
  }

  const availableLines =
    rows === undefined ? entries.length : Math.max(1, rows - lines.length);
  const shown = entries.slice(0, availableLines);
  for (const entry of shown) {
    lines.push(style(truncate(entry.text, columns), entry.style, color));
  }
  const hidden = entries.length - shown.length;
  if (hidden > 0 && (rows === undefined || lines.length < rows)) {
    lines.push(
      style(`           +${String(hidden)} more lines`, "\u001B[1;31m", color),
    );
  }
}

function aggregateState(states: readonly NodeState[]): NodeState {
  const priority: readonly NodeState[] = [
    "failed",
    "blocked",
    "skipped",
    "cancelling",
    "running",
    "retry_wait",
    "resource_wait",
    "ready",
    "cancelled",
    "pending",
  ];
  for (const state of priority) {
    if (states.includes(state)) return state;
  }
  return "succeeded";
}

function countStates(
  inspection: RunInspection,
): Readonly<Record<NodeState, number>> {
  const counts: Record<NodeState, number> = {
    pending: 0,
    ready: 0,
    resource_wait: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    cancelling: 0,
    cancelled: 0,
    retry_wait: 0,
  };
  for (const node of inspection.nodes) {
    counts[node.state] += 1;
  }
  return counts;
}

function sectionRule(label: string, columns: number, color: boolean): string {
  const prefix = `╭─ ${label} `;
  return style(
    `${prefix}${"─".repeat(Math.max(0, columns - prefix.length))}`,
    CYAN,
    color,
  );
}

function panelRow(
  value: string,
  columns: number,
  color: boolean,
  ansi: string,
): string {
  return style(`│ ${value.padEnd(columns - 4)} │`, ansi, color);
}

function progressBar(settled: number, total: number, width: number): string {
  const completed = total === 0 ? width : Math.round((settled / total) * width);
  return `[${"━".repeat(completed)}${"·".repeat(width - completed)}]`;
}

function leftRight(left: string, right: string, width: number): string {
  if (left.length + right.length + 1 > width) {
    return `${truncate(left, Math.max(1, width - right.length - 1))} ${truncate(right, width)}`;
  }
  return `${left}${" ".repeat(width - left.length - right.length)}${right}`;
}

function sharedNamespace(ids: readonly string[]): string {
  if (ids.length < 2) return "";
  const first = ids[0];
  if (first === undefined) return "";
  const lastHyphen = first.lastIndexOf("-");
  if (lastHyphen < 0) return "";
  const prefix = first.slice(0, lastHyphen + 1);
  return ids.every((id) => id.startsWith(prefix)) ? prefix : "";
}

function summarizeIds(ids: readonly string[], maxLength: number): string {
  if (ids.length === 0) return "";
  const shown: string[] = [];
  for (const id of ids) {
    const remaining = ids.length - shown.length;
    const suffix = remaining > 1 ? ` +${String(remaining - 1)}` : "";
    const candidate = [...shown, id].join(", ");
    if (shown.length > 0 && candidate.length + suffix.length > maxLength) {
      return `${shown.join(", ")} +${String(remaining)}`;
    }
    shown.push(id);
  }
  return shown.join(", ");
}

function objectValue(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function waveNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function plural(value: string, count: number): string {
  return count === 1 ? value : `${value}S`;
}

function style(value: string, ansi: string, color: boolean): string {
  return color ? `${ansi}${value}${RESET}` : value;
}

function stripAnsi(value: string): string {
  return value.replaceAll(/\u001B\[[0-9;]*m/gu, "");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 0) return "";
  if (maxLength === 1) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 1)}…`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
