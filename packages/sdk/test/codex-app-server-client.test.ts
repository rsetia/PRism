import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const client = createCodexAppServerStdioClient({
    command: process.execPath,
    commandArgs: [fixture, "--stay-alive"],
    model: "test-model",
    reasoningEffort: "medium",
  });
  const backend = createCodexAppServerBackend(client);
  const output: string[] = [];
  try {
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
        sandbox: "read-only",
      },
      { backend, onOutput: (text) => output.push(text) },
    );
    expect(result).toEqual({ status: "succeeded", output: "ok" });
    expect(output).toEqual(["working"]);
  } finally {
    await client.close();
  }
});

test("reconnects to a persisted active turn without starting it again", async () => {
  const root = mkdtempSync(join(tmpdir(), "prism-app-server-resume-"));
  directories.push(root);
  const nodeDir = join(root, "node");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(
    join(nodeDir, "result.json"),
    JSON.stringify({ status: "succeeded", output: "resumed-ok" }),
  );
  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "fake-codex-app-server.mjs",
  );
  const client = createCodexAppServerStdioClient({
    command: process.execPath,
    commandArgs: [fixture, "--stay-alive", "--resume-active"],
  });
  try {
    const session = await client.resume(
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
        nodeDir,
        worktreeDir: root,
        prompt: "must not be sent again",
        sandbox: "read-only",
      },
      { id: "thread-1", state: { turnId: "turn-1" } },
    );
    const events = [];
    for await (const event of client.events(session)) events.push(event);

    expect(events).toEqual([
      { kind: "output", text: "resumed" },
      {
        kind: "result",
        result: { status: "succeeded", output: "resumed-ok" },
      },
    ]);
  } finally {
    await client.close();
  }
});

test("redacts configured secrets from stderr and successful results", async () => {
  const root = mkdtempSync(join(tmpdir(), "prism-app-server-redact-"));
  directories.push(root);
  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "fake-codex-app-server.mjs",
  );
  const client = createCodexAppServerStdioClient({
    command: process.execPath,
    commandArgs: [fixture, "--stay-alive", "--emit-secret"],
    executionPolicy: {
      mode: "isolated",
      environment: {
        inherit: ["PATH"],
        values: { TEST_SECRET: "super-secret-value" },
        secretNames: ["TEST_SECRET"],
      },
    },
  });
  const output: string[] = [];
  try {
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
        sandbox: "read-only",
      },
      {
        backend: createCodexAppServerBackend(client),
        onOutput: (text) => output.push(text),
      },
    );
    expect(result).toEqual({
      status: "succeeded",
      output: { summary: "[REDACTED]" },
    });
    expect(output.join("")).toContain("[REDACTED]");
    expect(output.join("")).not.toContain("super-secret-value");
  } finally {
    await client.close();
  }
});

test("times out a stalled request", async () => {
  const root = mkdtempSync(join(tmpdir(), "prism-app-server-timeout-"));
  directories.push(root);
  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "fake-codex-app-server.mjs",
  );
  const client = createCodexAppServerStdioClient({
    command: process.execPath,
    commandArgs: [fixture, "--stay-alive", "--hang-initialize"],
    requestTimeoutMs: 50,
  });
  try {
    await expect(
      client.start({
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
        prompt: "unused",
      }),
    ).rejects.toThrow("initialize request timed out");
  } finally {
    await client.close();
  }
});

test("ends an active turn after its idle timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "prism-app-server-idle-"));
  directories.push(root);
  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "fake-codex-app-server.mjs",
  );
  const client = createCodexAppServerStdioClient({
    command: process.execPath,
    commandArgs: [fixture, "--stay-alive", "--silent-turn"],
    turnIdleTimeoutMs: 50,
  });
  try {
    const session = await client.start({
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
      prompt: "unused",
      sandbox: "read-only",
    });
    const events = [];
    for await (const event of client.events(session)) events.push(event);
    expect(events).toEqual([
      {
        kind: "protocol_error",
        error: "Codex App Server turn was silent for 50ms",
      },
    ]);
  } finally {
    await client.close();
  }
});
