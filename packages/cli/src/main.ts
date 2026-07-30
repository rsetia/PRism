#!/usr/bin/env node
/**
 * Process wiring only — all behavior lives in cli.ts. Anything thrown
 * that reaches here is by definition an unexpected internal error.
 */
import { EXIT_INTERNAL, runCli } from "./cli.js";

const io = {
  stdout: (line: string): void => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line: string): void => {
    process.stderr.write(`${line}\n`);
  },
  write: (text: string): void => {
    process.stdout.write(text);
  },
  interactive: process.stdout.isTTY === true,
  columns: process.stdout.columns,
  color: process.env["NO_COLOR"] === undefined,
};

try {
  process.exitCode = await runCli(process.argv.slice(2), io);
} catch (error) {
  io.stderr(`unexpected internal error: ${String(error)}`);
  process.exitCode = EXIT_INTERNAL;
}
