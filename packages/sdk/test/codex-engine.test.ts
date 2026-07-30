import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { buildCodexPrompt, createCodexEngine } from "../src/node/index.js";
import type {
  CodexEngine,
  CodexExecutorContract,
  WorkerSpec,
} from "../src/node/index.js";

const FAKE_CODEX = fileURLToPath(
  new URL("./fixtures/fake-codex.mjs", import.meta.url),
);
const root = mkdtempSync(join(tmpdir(), "prism-codex-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const contract: CodexExecutorContract = {
  instructions: "Implement the requested change and validate it.",
  allowsGitMutation: true,
  extraRules: ["Do not touch unrelated files."],
};

let counter = 0;
function paths() {
  counter += 1;
  const nodeDir = join(root, `node-${String(counter)}`);
  const worktreeDir = join(root, `worktree-${String(counter)}`);
  mkdirSync(worktreeDir, { recursive: true });
  return { nodeDir, worktreeDir };
}

function spec(mode = "success"): WorkerSpec {
  return {
    runId: "run-1",
    nodeId: "node-1",
    kind: "task",
    executor: "implement",
    input: { task: "fix it" },
    config: { mode },
    attempt: 1,
  };
}

function engine(): CodexEngine {
  return createCodexEngine({
    command: process.execPath,
    commandArgs: [FAKE_CODEX],
    skipGitRepoCheck: true,
    pollIntervalMs: 10,
    heartbeatIntervalMs: 10,
    killGraceMs: 100,
    stdio: "ignore",
  });
}

describe("buildCodexPrompt", () => {
  test("combines the executor contract with protocol and safety rules", () => {
    const prompt = buildCodexPrompt({
      spec: spec(),
      nodeDir: "/tmp/node",
      worktreeDir: "/tmp/worktree",
      specPath: "/tmp/node/spec.json",
      resultPath: "/tmp/node/result.json",
      heartbeatPath: "/tmp/node/heartbeat.json",
      contract,
    });
    expect(prompt).toContain("exactly one prism node");
    expect(prompt).toContain(contract.instructions);
    expect(prompt).toContain("Do not touch unrelated files.");
    expect(prompt).toContain("/tmp/node/result.json");
    expect(prompt).toContain('"status":"succeeded"');
  });
});

describe("createCodexEngine", () => {
  test("runs Codex with the prompt and accepts a valid result", async () => {
    const location = paths();
    const result = await engine().execute({
      ...location,
      spec: spec(),
      contract,
    });
    expect(result).toEqual({
      status: "succeeded",
      output: { task: "fix it" },
    });
    expect(
      readFileSync(join(location.nodeDir, "captured-prompt.txt"), "utf8"),
    ).toContain(contract.instructions);
    const args = JSON.parse(
      readFileSync(join(location.nodeDir, "captured-args.json"), "utf8"),
    ) as unknown;
    expect(args).toEqual(
      expect.arrayContaining([
        "exec",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--ephemeral",
        "--add-dir",
        location.nodeDir,
        "-",
      ]),
    );
    expect(existsSync(join(location.nodeDir, "heartbeat.json"))).toBe(true);
  });

  test("captures combined Codex stdout and stderr", async () => {
    const output: string[] = [];
    const result = await engine().execute({
      ...paths(),
      spec: spec(),
      contract,
      onOutput: (chunk) => output.push(chunk),
    });
    expect(result.status).toBe("succeeded");
    expect(output.join("")).toContain("fake codex stdout");
    expect(output.join("")).toContain("fake codex stderr");
  });

  test("accepts a result before Codex exits and terminates the child", async () => {
    const result = await engine().execute({
      ...paths(),
      spec: spec("result-then-stall"),
      contract,
    });
    expect(result.status).toBe("succeeded");
  });

  test("preserves a worker-reported classified failure", async () => {
    const result = await engine().execute({
      ...paths(),
      spec: spec("reported-failure"),
      contract,
    });
    expect(result).toEqual({
      status: "failed",
      error: "agent failed",
      failureClass: "semantic_failed",
    });
  });

  test("turns a missing result into persisted infrastructure failure", async () => {
    const location = paths();
    const result = await engine().execute({
      ...location,
      spec: spec("exit-no-result"),
      contract,
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("expected infrastructure failure");
    }
    expect(result.failureClass).toBe("transient_infra");
    expect(result.error).toContain("status 7");
    expect(result.error).toContain("fake codex details");
    expect(
      JSON.parse(readFileSync(join(location.nodeDir, "result.json"), "utf8")),
    ).toEqual(result);
  });

  test("turns a malformed result into infrastructure failure", async () => {
    const result = await engine().execute({
      ...paths(),
      spec: spec("malformed-result"),
      contract,
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("expected infrastructure failure");
    }
    expect(result.failureClass).toBe("transient_infra");
    expect(result.error).toContain("invalid result.json");
  });

  test("terminates on abort and returns through the result protocol", async () => {
    const controller = new AbortController();
    const execution = engine().execute({
      ...paths(),
      spec: spec("stall"),
      contract,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);
    const result = await execution;
    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("expected infrastructure failure");
    }
    expect(result.failureClass).toBe("transient_infra");
    expect(result.error).toContain("cancelled");
  });
});
