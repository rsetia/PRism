import type { CompiledGraph, NodeState, RunInspection } from "@rsetia/prism";

export interface WatchDashboardOptions {
  readonly columns?: number;
  readonly color?: boolean;
  readonly frame?: number;
}

const RESET = "\u001B[0m";
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
  pending: { symbol: "○", style: "\u001B[2m" },
  ready: { symbol: "◇", style: "\u001B[1;33m" },
  running: { symbol: "▶", style: "\u001B[1;30;46m" },
  succeeded: { symbol: "✓", style: "\u001B[1;32m" },
  failed: { symbol: "✕", style: "\u001B[1;37;41m" },
  blocked: { symbol: "⊘", style: "\u001B[1;35m" },
  cancelling: { symbol: "◌", style: "\u001B[1;33m" },
  cancelled: { symbol: "—", style: "\u001B[2m" },
  retry_wait: { symbol: "↻", style: "\u001B[1;33m" },
};

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
  const settled = inspection.nodes.filter((node) =>
    TERMINAL_STATES.has(node.state),
  ).length;
  const runStatus = inspection.finished
    ? counts.failed + counts.blocked + counts.cancelled > 0
      ? "FAILED"
      : "COMPLETE"
    : "RUNNING";
  const spinner = inspection.finished
    ? runStatus === "COMPLETE"
      ? "◆"
      : "!"
    : (SPINNERS[frame % SPINNERS.length] ?? "◐");
  const activeNodes = inspection.nodes.filter(
    (node) => node.state === "running" || node.state === "cancelling",
  );
  const activeSummary =
    activeNodes.length === 0
      ? style("none", "\u001B[2m", color)
      : activeNodes
          .map((node) =>
            style(`▶ ${node.nodeId}`, STATE_PRESENTATION.running.style, color),
          )
          .join("  ");
  const lines: string[] = [
    style(
      `${spinner} Prism · ${inspection.runId} · ${runStatus}`,
      runStatus === "FAILED"
        ? "\u001B[1;31m"
        : runStatus === "COMPLETE"
          ? "\u001B[1;32m"
          : "\u001B[1;36m",
      color,
    ),
    renderProgress(settled, inspection.nodes.length, columns, counts),
    `Active: ${activeSummary}`,
    style(
      "✓ succeeded  ▶ running  ◇ ready  ○ pending  ↻ retry  ✕ failed  ⊘ blocked",
      "\u001B[2m",
      color,
    ),
    "─".repeat(columns),
    style(`DAG · final: ${graph.finalNode}`, "\u001B[1m", color),
  ];

  const waves = buildWaves(graph);
  for (let index = 0; index < waves.length; index += 1) {
    const wave = waves[index] ?? [];
    if (index > 0) {
      lines.push(style(center("│", columns), "\u001B[2m", color));
      lines.push(style(center("▼", columns), "\u001B[2m", color));
    }
    lines.push(
      style(
        `Wave ${String(index)}${index === 0 ? " · roots" : ""}`,
        "\u001B[1m",
        color,
      ),
    );
    lines.push(...renderWaveCards(wave, graph, stateByNode, columns, color));
  }

  if (inspection.failures.length > 0) {
    lines.push("─".repeat(columns));
    lines.push(style("Failures", "\u001B[1;31m", color));
    for (const failure of inspection.failures) {
      lines.push(
        `  ✕ ${failure.nodeId}: ${truncate(JSON.stringify(failure.cause), columns - 6)}`,
      );
    }
  }
  return lines.join("\n");
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

function renderWaveCards(
  nodeIds: readonly string[],
  graph: CompiledGraph,
  stateByNode: ReadonlyMap<string, NodeState>,
  columns: number,
  color: boolean,
): string[] {
  const cardsPerRow = columns >= 138 ? 3 : columns >= 88 ? 2 : 1;
  const gap = 2;
  const cardWidth = Math.floor(
    (columns - gap * (cardsPerRow - 1)) / cardsPerRow,
  );
  const cards = nodeIds.map((nodeId) => {
    const node = graph.nodes[nodeId];
    const state = stateByNode.get(nodeId) ?? "pending";
    const presentation = STATE_PRESENTATION[state];
    const dependency =
      node === undefined || node.dependsOn.length === 0
        ? ""
        : node.dependsOn.length === 1
          ? ` ← ${node.dependsOn[0] ?? ""}`
          : ` ← ${node.dependsOn[0] ?? ""} +${String(node.dependsOn.length - 1)}`;
    const content = truncate(
      `${presentation.symbol} ${nodeId}${dependency}`,
      cardWidth - 2,
    );
    const card = `[${content.padEnd(cardWidth - 2)}]`;
    return style(card, presentation.style, color);
  });

  const lines: string[] = [];
  for (let index = 0; index < cards.length; index += cardsPerRow) {
    lines.push(cards.slice(index, index + cardsPerRow).join(" ".repeat(gap)));
  }
  return lines;
}

function renderProgress(
  settled: number,
  total: number,
  columns: number,
  counts: Readonly<Record<NodeState, number>>,
): string {
  const barWidth = clamp(Math.floor(columns / 4), 12, 28);
  const completedWidth =
    total === 0 ? barWidth : Math.round((settled / total) * barWidth);
  const bar = `${"█".repeat(completedWidth)}${"░".repeat(barWidth - completedWidth)}`;
  return `[${bar}] ${String(settled)}/${String(total)} settled · ${String(counts.running)} running · ${String(counts.ready)} ready · ${String(counts.failed)} failed`;
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

function style(value: string, ansi: string, color: boolean): string {
  return color ? `${ansi}${value}${RESET}` : value;
}

function center(value: string, width: number): string {
  return `${" ".repeat(Math.max(0, Math.floor((width - value.length) / 2)))}${value}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 1)}…`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
