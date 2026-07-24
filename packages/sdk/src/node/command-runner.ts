import { execFile } from "node:child_process";

/**
 * A seam for running external CLIs (`gh`, `bd`, validation commands) — the
 * §15 builtin executors depend on this, not on child_process directly, so
 * tests inject a fake runner and never touch a live binary.
 */

export interface CommandResult {
  /** Process exit code; a non-zero code is a RESULT, not a thrown error. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCommandOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: RunCommandOptions,
  ): Promise<CommandResult>;
}

/**
 * The default runner: spawn the command with execFile.
 *
 * Implementation notes:
 * - execFile(command, args, { cwd, signal, encoding: "utf8", maxBuffer })
 *   and resolve a CommandResult. A non-zero exit is a normal result
 *   (resolve with the code + captured stdout/stderr), NOT a rejection —
 *   the executor decides what a failed command means.
 * - Reject only for a real launch failure (ENOENT — the CLI isn't
 *   installed) or an aborted signal.
 * - Bound output with maxBuffer and surface an over-limit error clearly;
 *   never assume a caught value is an Error.
 * - Never pass the args through a shell (execFile, not exec) so a branch
 *   name with a space can't become an injection.
 */
export function createExecFileRunner(): CommandRunner {
  const maxBuffer = 1024 * 1024;

  return Object.freeze({
    run(
      command: string,
      args: readonly string[],
      options: RunCommandOptions = {},
    ): Promise<CommandResult> {
      return new Promise<CommandResult>((resolve, reject) => {
        execFile(
          command,
          [...args],
          {
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            encoding: "utf8",
            maxBuffer,
          },
          (error, stdout, stderr) => {
            const result = {
              stdout: String(stdout),
              stderr: String(stderr),
            };
            if (error === null) {
              resolve({ exitCode: 0, ...result });
              return;
            }

            if (
              options.signal?.aborted === true ||
              error.name === "AbortError" ||
              error.code === "ABORT_ERR"
            ) {
              const abortError = new Error(
                `Command ${quote(command)} was aborted`,
                { cause: error },
              );
              abortError.name = "AbortError";
              reject(abortError);
              return;
            }

            if (
              error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
              error.message.toLowerCase().includes("maxbuffer")
            ) {
              reject(
                new Error(
                  `Command output exceeded the ${String(maxBuffer)} byte maxBuffer for ${quote(command)}`,
                  { cause: error },
                ),
              );
              return;
            }

            if (typeof error.code === "number") {
              resolve({ exitCode: error.code, ...result });
              return;
            }

            reject(
              new Error(
                `Could not execute ${quote(command)}: ${error.message}`,
                { cause: error },
              ),
            );
          },
        );
      });
    },
  });
}

function quote(value: string): string {
  return JSON.stringify(value);
}
