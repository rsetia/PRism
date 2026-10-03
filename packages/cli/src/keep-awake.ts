import { spawn as nodeSpawn } from "node:child_process";

/** A held sleep assertion; release is idempotent. */
export interface KeepAwake {
  release(): void;
}

/** The slice of a spawned child that keep-awake needs. */
export interface KeepAwakeChild {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(): unknown;
  unref(): unknown;
}

export interface KeepAwakeOptions {
  /** Default process.platform; only "darwin" holds an assertion. */
  readonly platform?: NodeJS.Platform;
  /** Process whose lifetime bounds the assertion. Default process.pid. */
  readonly pid?: number;
  readonly spawn?: (command: string, args: readonly string[]) => KeepAwakeChild;
  /** Told once when the assertion cannot be held; the run continues. */
  readonly onUnavailable?: (reason: string) => void;
}

const NOT_HELD: KeepAwake = Object.freeze({ release: () => undefined });

/**
 * Keep a macOS host from idle-sleeping while a long run executes. Runs
 * left overnight otherwise stall with the lid open and the screen locked,
 * and resume hours later looking like slow work.
 *
 * `caffeinate -i -w <pid>` holds the assertion and exits on its own when
 * the watched process does, so a crashed run never leaves it behind. This
 * is best-effort: a missing `caffeinate` or a failed spawn is reported
 * once and never fails the run. Other platforms are a no-op.
 */
export function startKeepAwake(options: KeepAwakeOptions = {}): KeepAwake {
  if ((options.platform ?? process.platform) !== "darwin") return NOT_HELD;
  const spawn =
    options.spawn ??
    ((command: string, args: readonly string[]): KeepAwakeChild =>
      nodeSpawn(command, args, { stdio: "ignore" }));
  const unavailable = (reason: string): void => {
    options.onUnavailable?.(`cannot keep the host awake: ${reason}`);
  };

  let child: KeepAwakeChild;
  try {
    child = spawn("caffeinate", [
      "-i",
      "-w",
      String(options.pid ?? process.pid),
    ]);
  } catch (error: unknown) {
    unavailable(error instanceof Error ? error.message : String(error));
    return NOT_HELD;
  }
  let failed = false;
  child.on("error", (error) => {
    failed = true;
    unavailable(error.message);
  });
  // The assertion must never be what keeps the CLI process alive.
  child.unref();

  let released = false;
  return Object.freeze({
    release(): void {
      if (released) return;
      released = true;
      if (!failed && child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    },
  });
}
