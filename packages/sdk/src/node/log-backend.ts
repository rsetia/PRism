import { mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  LogBackend,
  LogTarget,
  LogWriter,
  ReadLogOptions,
} from "../runtime/ports.js";
import { encodePathComponent } from "./path-component.js";

/**
 * The LogBackend port (plan §14, from PRism-py). It owns writing a
 * worker's output and reading it back — including the follow-stream that
 * a future `logs --follow` command needs. The seam is what lets that
 * command stay identical whether logs come from a local file (`tail -f`)
 * or a remote pod (`kubectl logs -f`).
 */

export interface FileLogBackendOptions {
  /** Root directory the log files live under. */
  readonly baseDir: string;
}

/**
 * Store logs as append-only files under baseDir (plan §14). Reader and
 * writer share this backend instance in-process, so follow can use the
 * memory store's waiter pattern rather than fs.watch — a cross-process
 * follow (a worker writing the file directly) is the durable variant and
 * out of scope here.
 */
export function createFileLogBackend(
  options: FileLogBackendOptions,
): LogBackend {
  interface TargetState {
    closed: boolean;
    writerOpen: boolean;
    version: number;
    readonly waiters: Set<() => void>;
  }

  const baseDir = resolve(options.baseDir);
  const states = new Map<string, TargetState>();

  function stateFor(path: string): TargetState {
    let state = states.get(path);
    if (state === undefined) {
      state = {
        closed: false,
        writerOpen: false,
        version: 0,
        waiters: new Set(),
      };
      states.set(path, state);
    }
    return state;
  }

  function notify(state: TargetState): void {
    state.version += 1;
    const waiters = [...state.waiters];
    state.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  return Object.freeze({
    async openWriter(target: LogTarget): Promise<LogWriter> {
      const path = logPath(baseDir, target);
      const state = stateFor(path);
      if (state.writerOpen) {
        throw new Error(
          `A log writer is already open for ${target.runId}/${target.nodeId}/a${String(target.attempt)}`,
        );
      }

      state.writerOpen = true;
      state.closed = false;
      let handle: FileHandle;
      try {
        await mkdir(dirname(path), { recursive: true });
        handle = await open(path, "a");
      } catch (error: unknown) {
        state.writerOpen = false;
        state.closed = true;
        notify(state);
        throw error;
      }
      notify(state);

      let acceptingWrites = true;
      let tail: Promise<void> = Promise.resolve();
      let closePromise: Promise<void> | undefined;

      function enqueue(operation: () => Promise<void>): Promise<void> {
        const result = tail.then(operation);
        tail = result.catch(() => undefined);
        return result;
      }

      const writer: LogWriter = {
        write(chunk: string): Promise<void> {
          if (!acceptingWrites) {
            return Promise.reject(new Error("Cannot write to a closed log"));
          }
          return enqueue(async () => {
            await handle.appendFile(chunk, "utf8");
            notify(state);
          });
        },

        close(): Promise<void> {
          if (closePromise !== undefined) {
            return closePromise;
          }
          acceptingWrites = false;
          closePromise = enqueue(async () => {
            let failed = false;
            let failure: unknown;
            try {
              await handle.sync();
            } catch (error: unknown) {
              failed = true;
              failure = error;
            }
            try {
              await handle.close();
            } catch (error: unknown) {
              if (!failed) {
                failed = true;
                failure = error;
              }
            } finally {
              state.writerOpen = false;
              state.closed = true;
              notify(state);
            }
            if (failed) {
              throw failure;
            }
          });
          return closePromise;
        },
      };
      return Object.freeze(writer);
    },

    read(target: LogTarget, readOptions: ReadLogOptions = {}) {
      const path = logPath(baseDir, target);
      const follow = readOptions.follow ?? false;
      const signal = readOptions.signal;

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<string> {
          const decoder = new TextDecoder();
          let cursor = 0;
          const state = follow ? stateFor(path) : states.get(path);
          let reader: FileHandle | undefined;
          const buffer = new Uint8Array(64 * 1024);

          try {
            while (true) {
              const observedVersion = state?.version ?? 0;
              if (reader === undefined) {
                try {
                  reader = await open(path, "r");
                } catch (error: unknown) {
                  if (!isErrnoException(error, "ENOENT")) {
                    throw error;
                  }
                }
              }

              if (reader !== undefined) {
                while (true) {
                  const { bytesRead } = await reader.read(
                    buffer,
                    0,
                    buffer.byteLength,
                    cursor,
                  );
                  if (bytesRead === 0) {
                    break;
                  }
                  cursor += bytesRead;
                  const text = decoder.decode(buffer.subarray(0, bytesRead), {
                    stream: true,
                  });
                  if (text.length > 0) {
                    yield text;
                  }
                }
              }

              if (
                !follow ||
                signal?.aborted === true ||
                state?.closed === true
              ) {
                const finalText = decoder.decode();
                if (finalText.length > 0) {
                  yield finalText;
                }
                return;
              }

              if (state === undefined) {
                throw new Error("follow reader lost its target state");
              }
              await waitForChange(state, observedVersion, signal);
            }
          } finally {
            await reader?.close();
          }
        },
      };
    },
  });

  function waitForChange(
    state: TargetState,
    observedVersion: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (
      state.version !== observedVersion ||
      state.closed ||
      signal?.aborted === true
    ) {
      return Promise.resolve();
    }

    return new Promise((resolvePromise) => {
      const finish = (): void => {
        state.waiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolvePromise();
      };
      state.waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      if (
        state.version !== observedVersion ||
        state.closed ||
        signal?.aborted === true
      ) {
        finish();
      }
    });
  }
}

function logPath(baseDir: string, target: LogTarget): string {
  validateAttempt(target.attempt);
  return resolve(
    baseDir,
    encodePathComponent(target.runId, "log runId"),
    encodePathComponent(target.nodeId, "log nodeId"),
    `a${String(target.attempt)}.log`,
  );
}

function validateAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("log attempt must be an integer greater than 0");
  }
}

function isErrnoException(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
