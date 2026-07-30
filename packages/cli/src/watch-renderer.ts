import type { CompiledGraph, NodeState, RunInspection } from "@rsetia/prism";

export interface WatchDashboardOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly color?: boolean;
  readonly frame?: number;
}

const RESET = "\u001B[0m";
const DIM = "\u001B[2m";
const BOLD = "\u001B[1m";
const CYAN = "\u001B[1;36m";
const MAGENTA = "\u001B[1;35m";
const SPINNERS = ["◐", "◓", "◑", "◒"] as const;
const TERMINAL_STATES: ReadonlySet<NodeState> = new Set([
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
]);

interface StatePresentation {
  readonly symbol: string;
  readonly style: string;
}

const STATE_PRESENTATION: Readonly<Record<NodeState, StatePresentation>> = {
  pending: { symbol: "○", style: DIM },
  ready: { symbol: "◇", style: "\u001B[1;33m" },
  running: { symbol: "▶", style: "\u001B[1;30;46m" },
  succeeded: { symbol: "✓", style: "\u001B[1;32m" },
  failed: { symbol: "✕", style: "\u001B[1;37;41m" },
  blocked: { symbol: "⊘", style: "\u001B[1;35m" },
  cancelling: { symbol: "◌", style: "\u001B[1;33m" },
  cancelled: { symbol: "—", style: DIM },
  retry_wait: { symbol: "↻", style: "\u001B[1;33m" },
};

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
  const counts = countStates(inspection);
  const lines = renderHeader(inspection, counts, columns, color, frame);
  const workflows = extractBeadsWorkflows(graph);

  if (workflows.length > 0) {
    lines.push(
      ...renderBeadsDag(graph, workflows, stateByNode, columns, color),
    );
  } else {
    lines.push(...renderGenericDag(graph, stateByNode, columns, color));
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
  const queued = counts.pending + counts.ready + counts.retry_wait;
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
    if (
      workItem?.["provider"] !== "beads" ||
      typeof workItem["id"] !== "string"
    ) {
      continue;
    }

    const id = workItem["id"];
    const contextNodeId = node.dependsOn.find((dependencyId) => {
      const value = objectValue(
        objectValue(graph.nodes[dependencyId]?.config)?.["value"],
      );
      return value?.["provider"] === "beads" && value["id"] === id;
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
      lines.push(
        renderWorkflowLane(
          workflow,
          index === wave.length - 1,
          displayId,
          idWidth,
          stateByNode,
          columns,
          color,
        ),
      );
    }
  }

  const coveredNodes = new Set(
    workflows.flatMap((workflow) =>
      workflow.stages.map((stage) => stage.nodeId),
    ),
  );
  if (!coveredNodes.has(graph.finalNode)) {
    const state = stateByNode.get(graph.finalNode) ?? "pending";
    const presentation = STATE_PRESENTATION[state];
    lines.push(
      `${style("╰━━▶", CYAN, color)} ${style("◆ FINAL GATE", BOLD, color)}  ${style(presentation.symbol, presentation.style, color)} ${style(graph.finalNode, BOLD, color)}  ${style(`← ${String(workflows.length)} work items`, DIM, color)}`,
    );
  }
  return lines;
}

function renderWorkflowLane(
  workflow: BeadsWorkflow,
  lastInWave: boolean,
  displayId: (id: string) => string,
  idWidth: number,
  stateByNode: ReadonlyMap<string, NodeState>,
  columns: number,
  color: boolean,
): string {
  const states = workflow.stages.map(
    (stage) => stateByNode.get(stage.nodeId) ?? "pending",
  );
  const workflowState = aggregateState(states);
  const workflowPresentation = STATE_PRESENTATION[workflowState];
  const rail = lastInWave ? "╰─" : "├─";
  const id = truncate(displayId(workflow.id), idWidth).padEnd(idWidth);
  const pipelineWidth = workflow.stages.length * 3 - 2;
  const prefixWidth = rail.length + 1 + 1 + 1 + idWidth + 2 + pipelineWidth;
  const dependencyBudget = clamp(
    Math.floor(columns * 0.28),
    12,
    Math.max(12, columns - prefixWidth - 4),
  );
  const dependencies =
    workflow.dependencyIds.length === 0
      ? ""
      : `← ${summarizeIds(
          workflow.dependencyIds.map(displayId),
          dependencyBudget - 2,
        )}`;
  const fixedDetail = dependencies.length === 0 ? "" : `${dependencies}  `;
  const titleBudget = Math.max(
    0,
    columns - prefixWidth - fixedDetail.length - 2,
  );
  const title = truncate(workflow.title, titleBudget);
  const pipeline = renderPipeline(workflow.stages, states, color);

  return [
    style(rail, CYAN, color),
    " ",
    style(workflowPresentation.symbol, workflowPresentation.style, color),
    " ",
    style(id, BOLD, color),
    "  ",
    pipeline,
    dependencies.length === 0 ? "" : `  ${style(dependencies, MAGENTA, color)}`,
    title.length === 0 ? "" : `  ${title}`,
  ].join("");
}

function renderPipeline(
  stages: readonly WorkflowStage[],
  states: readonly NodeState[],
  color: boolean,
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
    const presentation = STATE_PRESENTATION[state];
    parts.push(style(presentation.symbol, presentation.style, color));
  }
  return parts.join("");
}

function renderGenericDag(
  graph: CompiledGraph,
  stateByNode: ReadonlyMap<string, NodeState>,
  columns: number,
  color: boolean,
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
      const presentation = STATE_PRESENTATION[state];
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
  if (inspection.failures.length === 0) {
    lines.push(
      style(
        truncate(
          "✓ done   ▶ running   ◇ ready   ○ queued   ↻ retry   ✕ failed   ⊘ blocked",
          columns,
        ),
        DIM,
        color,
      ),
    );
    return;
  }

  const availableLines =
    rows === undefined
      ? inspection.failures.length
      : Math.max(1, rows - lines.length);
  const shown = inspection.failures.slice(0, availableLines);
  for (const [index, failure] of shown.entries()) {
    const prefix = index === 0 ? "Failures · " : "           ";
    lines.push(
      style(
        truncate(
          `${prefix}✕ ${failure.nodeId}: ${JSON.stringify(failure.cause)}`,
          columns,
        ),
        "\u001B[1;31m",
        color,
      ),
    );
  }
  const hidden = inspection.failures.length - shown.length;
  if (hidden > 0 && (rows === undefined || lines.length < rows)) {
    lines.push(
      style(`           +${String(hidden)} more`, "\u001B[1;31m", color),
    );
  }
}

function aggregateState(states: readonly NodeState[]): NodeState {
  const priority: readonly NodeState[] = [
    "failed",
    "blocked",
    "cancelling",
    "running",
    "retry_wait",
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
    running: 0,
    succeeded: 0,
    failed: 0,
    blocked: 0,
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
