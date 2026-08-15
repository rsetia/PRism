import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  runAgentSession,
  type AgentSessionBackend,
} from "../src/node/index.js";

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

function input(nodeDir: string) {
  return {
    key: { runId: "run", nodeId: "node", attempt: 1 },
    nodeDir,
    worktreeDir: nodeDir,
    prompt: "do work",
    spec: {
      runId: "run",
      nodeId: "node",
      attempt: 1,
      kind: "task",
      executor: "implement",
      input: null,
      config: null,
    },
  } as const;
}

test("starts, observes, steers, interrupts, and resumes a durable backend session", async () => {
  const calls: string[] = [];
  let pass = 0;
  const backend: AgentSessionBackend = {
    name: "fake",
    async start() {
      calls.push("start");
      return { id: "s-1", state: { cursor: 1 } };
    },
    async resume(_input, session) {
      calls.push(`resume:${session.id}`);
      return session;
    },
    async steer(_session, message) {
      calls.push(`steer:${message}`);
    },
    async interrupt() {
      calls.push("interrupt");
    },
    async *events() {
      if (pass++ === 0)
        yield { kind: "result", result: { status: "succeeded", output: null } };
      else
        yield {
          kind: "result",
          result: { status: "succeeded", output: "resumed" },
        };
    },
  };
  const nodeDir = mkdtempSync(join(tmpdir(), "prism-session-"));
  directories.push(nodeDir);
  await expect(runAgentSession(input(nodeDir), { backend })).resolves.toEqual({
    status: "succeeded",
    output: null,
  });
  await expect(runAgentSession(input(nodeDir), { backend })).resolves.toEqual({
    status: "succeeded",
    output: "resumed",
  });
  const session = { id: "s-1", state: { cursor: 1 } };
  await backend.steer(session, "continue");
  await backend.interrupt(session);
  expect(calls).toEqual(["start", "resume:s-1", "steer:continue", "interrupt"]);
});

test("classifies backend protocol errors", async () => {
  const nodeDir = mkdtempSync(join(tmpdir(), "prism-session-"));
  directories.push(nodeDir);
  const backend: AgentSessionBackend = {
    name: "fake",
    async start() {
      return { id: "s", state: null };
    },
    async resume(_input, session) {
      return session;
    },
    async steer() {},
    async interrupt() {},
    async *events() {
      yield { kind: "protocol_error", error: "bad frame" } as const;
    },
  };
  await expect(
    runAgentSession(input(nodeDir), { backend }),
  ).resolves.toMatchObject({
    status: "failed",
    failureClass: "transient_infra",
  });
});

test("uses the durable run, node, and attempt identity to isolate sessions", async () => {
  const nodeDir = mkdtempSync(join(tmpdir(), "prism-session-"));
  directories.push(nodeDir);
  const calls: string[] = [];
  const backend: AgentSessionBackend = {
    name: "fake",
    async start(input) {
      calls.push(`start:${input.key.attempt}`);
      return { id: `session-${String(input.key.attempt)}`, state: null };
    },
    async resume(_input, session) {
      calls.push(`resume:${session.id}`);
      return session;
    },
    async steer() {},
    async interrupt() {},
    async *events() {
      yield {
        kind: "result",
        result: { status: "succeeded", output: null },
      } as const;
    },
  };
  await runAgentSession(input(nodeDir), { backend });
  await runAgentSession(input(nodeDir), { backend });
  await runAgentSession(
    { ...input(nodeDir), key: { runId: "run", nodeId: "node", attempt: 2 } },
    { backend },
  );
  expect(calls).toEqual(["start:1", "resume:session-1", "start:2"]);
});
