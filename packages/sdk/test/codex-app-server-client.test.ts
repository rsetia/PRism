import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  createCodexAppServerBackend,
  createCodexAppServerStdioClient,
  runAgentSession,
} from "../src/node/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("runs a worker through the selectable Codex App Server stdio transport", async () => {
  const root = mkdtempSync(join(tmpdir(), "prism-app-server-"));
  directories.push(root);
  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "fake-codex-app-server.mjs",
  );
  const backend = createCodexAppServerBackend(
    createCodexAppServerStdioClient({
      command: process.execPath,
      commandArgs: [fixture],
      model: "test-model",
      reasoningEffort: "medium",
    }),
  );
  const output: string[] = [];
  const result = await runAgentSession(
    {
      key: { runId: "run", nodeId: "node", attempt: 1 },
      spec: {
        runId: "run",
        nodeId: "node",
        kind: "task",
        executor: "implement",
        input: null,
        config: null,
        attempt: 1,
      },
      nodeDir: join(root, "node"),
      worktreeDir: root,
      prompt: `- On success, write ${join(root, "node", "result.json")} as JSON:`,
    },
    { backend, onOutput: (text) => output.push(text) },
  );
  expect(result).toEqual({ status: "succeeded", output: "ok" });
  expect(output).toEqual(["working"]);
});
