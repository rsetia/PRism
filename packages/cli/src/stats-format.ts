import { combineCriticalPathPhases } from "@rsetia/prism";
import type { PhaseShare, RunStats } from "@rsetia/prism";

/** A run's stats as `prism stats` prints them; null stats means untimed. */
export interface RunStatsReport {
  readonly runId: string;
  readonly finished: boolean;
  readonly stats: RunStats | null;
}

/**
 * Render one run's stats as text lines. Durations are scaled for runs that
 * last hours: seconds, then minutes, then hours.
 */
export function formatRunStats(report: RunStatsReport): string[] {
  const { stats } = report;
  const header = `${report.runId} (${report.finished ? "finished" : "running"})`;
  if (stats === null) {
    return [
      header,
      "  timing unavailable (legacy event log without timestamps)",
    ];
  }
  const lines = [
    header,
    `  wall ${formatSpan(stats.wallMs)}${stats.untimedEventCount === 0 ? "" : ` · ${String(stats.untimedEventCount)} event(s) without timestamps skipped`}`,
  ];

  const path = stats.criticalPath;
  const unattributedMs = Math.max(0, stats.wallMs - path.attributedMs);
  lines.push(
    `  critical path: ${String(path.nodeIds.length)} node(s), ${String(path.implementNodeCount)} implement · ${formatSpan(path.attributedMs)} in phases · ${formatSpan(unattributedMs)} outside them`,
    `    ${formatShares(path.phases)}`,
  );

  lines.push("  phases (intervals · median · p90 · total):");
  for (const phase of stats.phases) {
    if (phase.totalMs === 0) continue;
    lines.push(
      `    ${phase.phase.padEnd(20)} ${String(phase.count).padStart(4)} · ${formatSpan(phase.medianMs).padStart(6)} · ${formatSpan(phase.p90Ms).padStart(6)} · ${formatSpan(phase.totalMs).padStart(6)}`,
    );
  }

  const rounds = stats.reviewRounds;
  lines.push(
    rounds.mean === null
      ? "  review rounds: none"
      : `  review rounds: mean ${rounds.mean.toFixed(1)} · max ${String(rounds.max)} over ${String(rounds.nodes.length)} node(s)`,
  );

  lines.push(`  idle (no worker running): ${formatSpan(stats.idle.totalMs)}`);
  for (const gap of stats.idle.gaps) {
    lines.push(
      `    ${formatSpan(gap.durationMs)} until ${gap.endedBy.kind} ${gap.endedBy.nodeId}`,
    );
  }

  const events = stats.events;
  lines.push(
    `  events: ${String(events.failed)} failed · ${String(events.reset)} reset · ${String(events.blocked)} blocked · ${String(events.cancelled)} cancelled · ${String(events.retryWait)} retry wait(s)`,
  );
  const merges = stats.merges;
  if (merges.direct + merges.agent + merges.reconciled > 0) {
    lines.push(
      `  merges: ${String(merges.direct)} direct · ${String(merges.agent)} agent · ${String(merges.reconciled)} already merged`,
    );
  }
  return lines;
}

/** Totals across several runs, printed after their individual blocks. */
export function formatCombinedStats(
  reports: readonly RunStatsReport[],
): string[] {
  const timed = reports.flatMap((report) =>
    report.stats === null ? [] : [report.stats],
  );
  if (timed.length === 0) return [];
  const wallMs = timed.reduce((sum, stats) => sum + stats.wallMs, 0);
  const idleMs = timed.reduce((sum, stats) => sum + stats.idle.totalMs, 0);
  const reviewed = timed.flatMap((stats) => stats.reviewRounds.nodes);
  const rounds = reviewed.reduce((sum, node) => sum + node.rounds, 0);
  return [
    `all runs (${String(timed.length)} timed of ${String(reports.length)})`,
    `  wall ${formatSpan(wallMs)} · idle ${formatSpan(idleMs)}`,
    `  critical paths: ${formatShares(combineCriticalPathPhases(timed))}`,
    reviewed.length === 0
      ? "  review rounds: none"
      : `  review rounds: mean ${(rounds / reviewed.length).toFixed(1)} · max ${String(reviewed.reduce((max, node) => Math.max(max, node.rounds), 0))} over ${String(reviewed.length)} node(s)`,
  ];
}

function formatShares(phases: readonly PhaseShare[]): string {
  const visible = phases.filter((phase) => phase.durationMs > 0).slice(0, 6);
  return visible.length === 0
    ? "none"
    : visible
        .map(
          (phase) =>
            `${phase.phase} ${formatSpan(phase.durationMs)} (${(phase.share * 100).toFixed(0)}%)`,
        )
        .join(" · ");
}

/** 45s, 12.5m, 3.2h. */
export function formatSpan(durationMs: number): string {
  // Choose the unit from the rounded value so 59.6s prints as 1.0m, not 60s.
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Number((durationMs / 60_000).toFixed(1));
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(durationMs / 3_600_000).toFixed(1)}h`;
}
