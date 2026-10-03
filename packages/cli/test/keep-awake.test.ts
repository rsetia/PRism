import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import {
  startKeepAwake,
  type KeepAwake,
  type KeepAwakeChild,
} from "../src/keep-awake.js";

interface FakeChild extends KeepAwakeChild {
  exitCode: number | null;
  kills: number;
  unrefs: number;
  emitError(error: Error): void;
}

function fakeChild(): FakeChild {
  let onError: ((error: Error) => void) | undefined;
  const child: FakeChild = {
    exitCode: null,
    signalCode: null,
    kills: 0,
    unrefs: 0,
    on(_event, listener) {
      onError = listener;
      return child;
    },
    kill() {
      child.kills += 1;
      return true;
    },
    unref() {
      child.unrefs += 1;
      return child;
    },
    emitError(error) {
      onError?.(error);
    },
  };
  return child;
}

describe("startKeepAwake", () => {
  test("holds caffeinate on the watched pid and releases it once", () => {
    const child = fakeChild();
    const spawned: (readonly string[])[] = [];
    const held = startKeepAwake({
      platform: "darwin",
      pid: 4242,
      spawn: (command, args) => {
        spawned.push([command, ...args]);
        return child;
      },
    });
    expect(spawned).toEqual([["caffeinate", "-i", "-w", "4242"]]);
    expect(child.unrefs).toBe(1);
    held.release();
    held.release();
    expect(child.kills).toBe(1);
  });

  test("does nothing off macOS", () => {
    let spawned = false;
    startKeepAwake({
      platform: "linux",
      spawn: () => {
        spawned = true;
        return fakeChild();
      },
    }).release();
    expect(spawned).toBe(false);
  });

  test("reports a missing caffeinate without throwing", () => {
    const child = fakeChild();
    const reasons: string[] = [];
    const held = startKeepAwake({
      platform: "darwin",
      spawn: () => child,
      onUnavailable: (reason) => reasons.push(reason),
    });
    child.emitError(new Error("spawn caffeinate ENOENT"));
    held.release();
    expect(reasons).toEqual([
      "cannot keep the host awake: spawn caffeinate ENOENT",
    ]);
    expect(child.kills).toBe(0);
  });

  test("reports a spawn that throws without throwing", () => {
    const reasons: string[] = [];
    const held = startKeepAwake({
      platform: "darwin",
      spawn: () => {
        throw new Error("EAGAIN");
      },
      onUnavailable: (reason) => reasons.push(reason),
    });
    held.release();
    expect(reasons).toEqual(["cannot keep the host awake: EAGAIN"]);
  });

  test("does not signal a caffeinate that already exited", () => {
    const child = fakeChild();
    const held = startKeepAwake({ platform: "darwin", spawn: () => child });
    child.exitCode = 0;
    held.release();
    expect(child.kills).toBe(0);
  });
});

describe("runCli keep-awake", () => {
  const graph = fileURLToPath(
    new URL("./fixtures/valid.json", import.meta.url),
  );
  const home = mkdtempSync(join(tmpdir(), "prism-keep-awake-"));
  const previousHome = process.env["PRISM_HOME"];
  beforeAll(() => {
    process.env["PRISM_HOME"] = home;
  });
  afterAll(() => {
    if (previousHome === undefined) delete process.env["PRISM_HOME"];
    else process.env["PRISM_HOME"] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const io: CliIo = { stdout: () => undefined, stderr: () => undefined };

  function counter(): {
    keepAwake: () => KeepAwake;
    acquired: () => number;
    released: () => number;
  } {
    let acquired = 0;
    let released = 0;
    return {
      keepAwake: () => {
        acquired += 1;
        return { release: () => void (released += 1) };
      },
      acquired: () => acquired,
      released: () => released,
    };
  }

  test("run holds the host awake for its duration", async () => {
    const keep = counter();
    const code = await runCli(["run", graph], io, {
      keepAwake: keep.keepAwake,
    });
    expect(code).toBe(0);
    expect(keep.acquired()).toBe(1);
    expect(keep.released()).toBe(1);
  });

  test("--allow-sleep runs without holding the host awake", async () => {
    const keep = counter();
    const code = await runCli(["run", graph, "--allow-sleep"], io, {
      keepAwake: keep.keepAwake,
    });
    expect(code).toBe(0);
    expect(keep.acquired()).toBe(0);
  });

  test("read-only commands never hold the host awake", async () => {
    const keep = counter();
    await runCli(["validate", graph], io, { keepAwake: keep.keepAwake });
    expect(keep.acquired()).toBe(0);
    expect(
      await runCli(["status", "--allow-sleep"], io, {
        keepAwake: keep.keepAwake,
      }),
    ).toBe(2);
  });
});
