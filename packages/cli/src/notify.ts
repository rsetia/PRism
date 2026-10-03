import { execFile } from "node:child_process";
import {
  describeFailure,
  type PersistedRunEvent,
  type RunOutcome,
} from "@rsetia/prism";

/**
 * Operator notifications. A run that stops on a failure or a blocker waits
 * for a human, and nobody keeps `prism watch` open for hours: recorded runs
 * sat idle for 2-10 hours before anyone noticed. The process driving the
 * run tells the operator the moment their attention is needed.
 *
 * Delivery is best effort. A notifier that throws, hangs, or is missing
 * never affects the run.
 */

export interface OperatorNotification {
  readonly title: string;
  readonly message: string;
}

export interface OperatorNotifier {
  notify(notification: OperatorNotification): Promise<void>;
}

/** Runs shorter than this finish while the operator is still watching. */
export const RUN_FINISHED_NOTIFY_AFTER_MS = 60_000;

export interface DesktopNotifierOptions {
  readonly platform?: NodeJS.Platform;
  /** Run a command with argv; resolves even when the command fails. */
  readonly exec?: (command: string, args: readonly string[]) => Promise<void>;
  /** Terminal bell sink; called only when it is a terminal. */
  readonly bell?: () => void;
}

/**
 * macOS Notification Center through `osascript`, `notify-send` on Linux,
 * otherwise only the terminal bell. Text travels as argv, never through a
 * shell or an AppleScript string literal, so a cause cannot inject script.
 */
export function createDesktopNotifier(
  options: DesktopNotifierOptions = {},
): OperatorNotifier {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? execBestEffort;
  const bell =
    options.bell ??
    ((): void => {
      if (process.stderr.isTTY) process.stderr.write("\u0007");
    });
  return Object.freeze({
    async notify(notification: OperatorNotification): Promise<void> {
      bell();
      if (platform === "darwin") {
        await exec("osascript", [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          notification.title,
          notification.message,
        ]);
      } else if (platform === "linux") {
        await exec("notify-send", [
          "--",
          notification.title,
          notification.message,
        ]);
      }
    },
  });
}

function execBestEffort(
  command: string,
  args: readonly string[],
): Promise<void> {
  return new Promise((resolveExec) => {
    try {
      execFile(command, [...args], { timeout: 10_000 }, () => {
        resolveExec();
      });
    } catch {
      resolveExec();
    }
  });
}

/** Whether the environment opted out (PRISM_NOTIFY=0), e.g. tests or CI. */
export function notificationsDisabledByEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env["PRISM_NOTIFY"];
  return value === "0" || value === "false";
}

export interface OperatorAlertsInput {
  readonly notifier: OperatorNotifier;
  readonly runId: string;
  readonly project?: string;
  readonly events: AsyncIterable<PersistedRunEvent>;
  /** Events below this sequence predate this process (resume); skip them. */
  readonly fromSeq: number;
  readonly now?: () => number;
}

export interface OperatorAlerts {
  /**
   * Notify the run's outcome. The run is finished, so its event cursor is
   * drained first (bounded by DRAIN_TIMEOUT_MS): the failure that ended
   * the run is usually the last event and must not be dropped.
   */
  finish(outcome: RunOutcome): Promise<void>;
  /** Stop following without notifying (idempotent; also after finish). */
  stop(): void;
}

/** Longest finish() waits for a finished run's cursor to drain. */
export const DRAIN_TIMEOUT_MS = 5_000;

/**
 * Follow a run's events and notify on each node that now needs the
 * operator. `node_failed` is only recorded once in-run retries are spent
 * (a retried failure is `node_retry_wait`), so every one is actionable.
 * Blocked dependents are not notified: their root cause already was.
 */
export function followOperatorAlerts(
  input: OperatorAlertsInput,
): OperatorAlerts {
  const now = input.now ?? Date.now;
  // This process's share of the run: after a resume, a long run whose
  // resumed segment is short finishes while the operator is watching.
  const startedAt = now();
  const label = `${input.project === undefined ? "" : `${input.project} · `}${shortRunId(input.runId)}`;
  const send = async (notification: OperatorNotification): Promise<void> => {
    try {
      await input.notifier.notify(notification);
    } catch {
      // Best effort: a notification never affects the run.
    }
  };

  let stopped = false;
  let pending = Promise.resolve();
  const iterator = input.events[Symbol.asyncIterator]();
  const following = (async (): Promise<void> => {
    try {
      while (!stopped) {
        const next = await iterator.next();
        if (next.done === true || stopped) return;
        const event = next.value;
        if (event.seq < input.fromSeq || event.kind !== "node_failed") {
          continue;
        }
        const detail = describeFailure(event.failure, {
          runId: input.runId,
          finished: false,
        });
        const notification = {
          title:
            detail.disposition === "needs_input"
              ? `Prism needs input · ${label}`
              : `Prism node failed · ${label}`,
          message: `${event.nodeId}: ${detail.summary}\n${detail.hint}`,
        };
        pending = pending.then(() => send(notification));
      }
    } catch {
      // The event cursor ends with the store; the outcome still notifies.
    }
  })();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  };

  return Object.freeze({
    async finish(outcome: RunOutcome): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        following,
        new Promise<void>((resolveDrain) => {
          timer = setTimeout(resolveDrain, DRAIN_TIMEOUT_MS);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      stop();
      await pending;
      if (
        outcome.status === "cancelled" ||
        now() - startedAt < RUN_FINISHED_NOTIFY_AFTER_MS
      ) {
        return;
      }
      await send(
        outcome.status === "succeeded"
          ? { title: `Prism run succeeded · ${label}`, message: input.runId }
          : {
              title: `Prism run failed · ${label}`,
              message: `${String(outcome.failures.length)} failed node(s): ${outcome.failures.map((failure) => failure.nodeId).join(", ")}\nprism inspect ${input.runId}`,
            },
      );
    },
    stop,
  });
}

function shortRunId(runId: string): string {
  return runId.startsWith("run-") ? runId.slice(0, 12) : runId;
}
