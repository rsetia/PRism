import { describe, expect, test } from "vitest";
import type { PersistedRunEvent, RunOutcome } from "@rsetia/prism";
import {
  createDesktopNotifier,
  followOperatorAlerts,
  notificationsDisabledByEnv,
  RUN_FINISHED_NOTIFY_AFTER_MS,
  type OperatorNotification,
  type OperatorNotifier,
} from "../src/notify.js";

function recordingNotifier(): {
  notifier: OperatorNotifier;
  sent: OperatorNotification[];
} {
  const sent: OperatorNotification[] = [];
  return {
    sent,
    notifier: {
      notify(notification) {
        sent.push(notification);
        return Promise.resolve();
      },
    },
  };
}

async function* eventsOf(
  events: readonly PersistedRunEvent[],
): AsyncIterable<PersistedRunEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

/** Let the follower drain a finite event stream. */
function settle(): Promise<void> {
  return new Promise((resolveSettle) => setTimeout(resolveSettle, 0));
}

function event(seq: number, body: Record<string, unknown>): PersistedRunEvent {
  return { seq, timestampMs: seq, ...body } as unknown as PersistedRunEvent;
}

const failed: RunOutcome = {
  status: "failed",
  failures: [{ nodeId: "implement-a", cause: "boom" }],
};

describe("followOperatorAlerts", () => {
  test("notifies terminal failures and blockers, not retries or blocked dependents", async () => {
    const { notifier, sent } = recordingNotifier();
    const alerts = followOperatorAlerts({
      notifier,
      runId: "run-1234567890abcdef",
      project: "drownwars",
      fromSeq: 0,
      events: eventsOf([
        event(0, {
          kind: "node_retry_wait",
          nodeId: "implement-a",
          attempt: 1,
          delayMs: 10,
          failure: {
            nodeId: "implement-a",
            cause: "git lock",
            failureClass: "transient_infra",
          },
        }),
        event(1, {
          kind: "node_failed",
          nodeId: "implement-a",
          failure: {
            nodeId: "implement-a",
            cause: { code: "X", error: "tests failed\nmore detail" },
            failureClass: "semantic_failed",
          },
        }),
        event(2, {
          kind: "node_blocked",
          nodeId: "merge-a",
          blockedBy: ["implement-a"],
        }),
        event(3, {
          kind: "node_failed",
          nodeId: "implement-b",
          failure: {
            nodeId: "implement-b",
            cause: "Blocker: which API version?",
            failureClass: "needs_input",
          },
        }),
      ]),
    });
    await settle();
    await alerts.finish(failed);
    expect(sent).toEqual([
      {
        title: "Prism node failed · drownwars · run-12345678",
        message:
          "implement-a: tests failed\ninspect the logs: prism logs run-1234567890abcdef",
      },
      {
        title: "Prism needs input · drownwars · run-12345678",
        message:
          "implement-b: Blocker: which API version?\nresolve the blocker, then: prism rerun-node run-1234567890abcdef implement-b",
      },
    ]);
  });

  test("skips failures recorded before this process resumed the run", async () => {
    const { notifier, sent } = recordingNotifier();
    const alerts = followOperatorAlerts({
      notifier,
      runId: "poll-linear",
      fromSeq: 1,
      events: eventsOf([
        event(0, {
          kind: "node_failed",
          nodeId: "old",
          failure: { nodeId: "old", cause: "earlier" },
        }),
        event(1, {
          kind: "node_failed",
          nodeId: "new",
          failure: { nodeId: "new", cause: "now", failureClass: "timeout" },
        }),
      ]),
    });
    await settle();
    await alerts.finish({ status: "cancelled", reason: null, failures: [] });
    expect(sent.map((notification) => notification.message)).toEqual([
      "new: now\ninspect the logs: prism logs poll-linear",
    ]);
    expect(sent[0]?.title).toBe("Prism node failed · poll-linear");
  });

  test("notifies a run outcome only for runs that outlast the operator's attention", async () => {
    let clock = 0;
    const { notifier, sent } = recordingNotifier();
    const quick = followOperatorAlerts({
      notifier,
      runId: "run-quick",
      fromSeq: 0,
      events: eventsOf([]),
      now: () => clock,
    });
    clock = RUN_FINISHED_NOTIFY_AFTER_MS - 1;
    await quick.finish({ status: "succeeded", output: null });
    expect(sent).toEqual([]);

    clock = 0;
    const slow = followOperatorAlerts({
      notifier,
      runId: "run-slow",
      fromSeq: 0,
      events: eventsOf([]),
      now: () => clock,
    });
    clock = RUN_FINISHED_NOTIFY_AFTER_MS;
    await slow.finish(failed);
    expect(sent).toEqual([
      {
        title: "Prism run failed · run-slow",
        message: "1 failed node(s): implement-a\nprism inspect run-slow",
      },
    ]);
  });

  test("never lets a broken notifier or event cursor reach the run", async () => {
    let clock = 0;
    const alerts = followOperatorAlerts({
      notifier: {
        notify: () => Promise.reject(new Error("no notification center")),
      },
      runId: "run-x",
      fromSeq: 0,
      events: (async function* (): AsyncIterable<PersistedRunEvent> {
        await Promise.resolve();
        throw new Error("store closed");
      })(),
      now: () => clock,
    });
    clock = RUN_FINISHED_NOTIFY_AFTER_MS;
    await settle();
    await expect(
      alerts.finish({ status: "succeeded", output: null }),
    ).resolves.toBeUndefined();
  });
});

describe("createDesktopNotifier", () => {
  function recordingExec(): {
    exec: (command: string, args: readonly string[]) => Promise<void>;
    calls: { command: string; args: readonly string[] }[];
  } {
    const calls: { command: string; args: readonly string[] }[] = [];
    return {
      calls,
      exec: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve();
      },
    };
  }

  test("passes text to osascript as argv, never as script source", async () => {
    const { exec, calls } = recordingExec();
    let bells = 0;
    const title = 'Prism "quoted" · run';
    const message = 'node: end tell\n" & do shell script "rm -rf ~';
    await createDesktopNotifier({
      platform: "darwin",
      exec,
      bell: () => {
        bells += 1;
      },
    }).notify({ title, message });
    expect(bells).toBe(1);
    expect(calls).toEqual([
      {
        command: "osascript",
        args: [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          title,
          message,
        ],
      },
    ]);
  });

  test("uses notify-send on Linux and only the bell elsewhere", async () => {
    const linux = recordingExec();
    await createDesktopNotifier({
      platform: "linux",
      exec: linux.exec,
      bell: () => undefined,
    }).notify({ title: "t", message: "m" });
    expect(linux.calls).toEqual([{ command: "notify-send", args: ["t", "m"] }]);

    const windows = recordingExec();
    let bells = 0;
    await createDesktopNotifier({
      platform: "win32",
      exec: windows.exec,
      bell: () => {
        bells += 1;
      },
    }).notify({ title: "t", message: "m" });
    expect(windows.calls).toEqual([]);
    expect(bells).toBe(1);
  });
});

describe("notificationsDisabledByEnv", () => {
  test("PRISM_NOTIFY=0 or false opts out", () => {
    expect(notificationsDisabledByEnv({ PRISM_NOTIFY: "0" })).toBe(true);
    expect(notificationsDisabledByEnv({ PRISM_NOTIFY: "false" })).toBe(true);
    expect(notificationsDisabledByEnv({ PRISM_NOTIFY: "1" })).toBe(false);
    expect(notificationsDisabledByEnv({})).toBe(false);
  });
});
