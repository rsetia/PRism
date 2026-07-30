import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileGraph, parseGraph } from "@rsetia/prism";
import type { CompiledGraph } from "@rsetia/prism";
import { createFileLogBackend, createSqliteStore } from "@rsetia/prism/node";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Integration tests spawn the BUILT executable — in-process calls prove
 * nothing about bin wiring, argument handling, stream separation, or
 * exit codes. Requires `npm run build` first (verify runs build before
 * test).
 */
const CLI_PATH = fileURLToPath(new URL("../dist/main.js", import.meta.url));
if (!existsSync(CLI_PATH)) {
  throw new Error("CLI is not built — run `npm run build` first");
}

const execFileAsync = promisify(execFile);
const defaultTestPrismHome = mkdtempSync(
  join(tmpdir(), "prism-cli-default-home-"),
);
afterAll(() => {
  rmSync(defaultTestPrismHome, { recursive: true, force: true });
});

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function resumableGraph(): CompiledGraph {
  const parsed = parseGraph({
    version: 1,
    nodes: {
      first: { executor: "constant", config: { value: "hello" } },
      second: { executor: "passthrough", dependsOn: ["first"] },
    },
    finalNode: "second",
  });
  if (!parsed.ok) {
    throw new Error("resumable graph fixture did not parse");
  }
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) {
    throw new Error("resumable graph fixture did not compile");
  }
  return compiled.graph;
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(...args: readonly string[]): Promise<CliResult> {
  return cliWith({ prismHome: defaultTestPrismHome }, ...args);
}

async function cliWith(
  options: {
    readonly cwd?: string;
    readonly prismHome?: string | null;
  },
  ...args: readonly string[]
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.prismHome === null) {
    delete env["PRISM_HOME"];
  } else if (options.prismHome !== undefined) {
    env["PRISM_HOME"] = options.prismHome;
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, ...args],
      {
        timeout: 10_000,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failed.code === "number" ? failed.code : -1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

describe("prism CLI", () => {
  test("no command prints usage to stderr, exit 2", async () => {
    const result = await cli();
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });

  test("unknown command exits 2", async () => {
    const result = await cli("frobnicate");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  test("unrecognized flag exits 2", async () => {
    const result = await cli("run", fixture("valid.json"), "--bogus");
    expect(result.code).toBe(2);
  });

  test("validate: valid file exits 0 with empty stdout", async () => {
    const result = await cli("validate", fixture("valid.json"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("validate: compile error goes to stderr with its code, exit 2", async () => {
    const result = await cli("validate", fixture("invalid.json"));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CYCLE");
  });

  test("validate: missing file exits 2 with a diagnostic", async () => {
    const result = await cli("validate", fixture("does-not-exist.json"));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });

  test("validate: malformed JSON exits 2", async () => {
    const result = await cli("validate", fixture("malformed.json"));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });

  test("graph: stable text plan on stdout", async () => {
    const result = await cli("graph", fixture("valid.json"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      ["first (constant)", "second (passthrough) <- first", "final: second"]
        .map((line) => `${line}\n`)
        .join(""),
    );
  });

  test("graph --json: versioned, parseable, pure stdout", async () => {
    const result = await cli("graph", fixture("valid.json"), "--json");
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout) as {
      version: number;
      order: string[];
      finalNode: string;
      nodes: Record<
        string,
        { executor: string; kind: string; dependsOn: string[] }
      >;
    };
    expect(plan.version).toBe(1);
    expect(plan.order).toEqual(["first", "second"]);
    expect(plan.finalNode).toBe("second");
    expect(plan.nodes["second"]?.kind).toBe("task");
    expect(plan.nodes["second"]?.dependsOn).toEqual(["first"]);
  });

  test("run: success prints the output value to stdout, exit 0", async () => {
    const result = await cli("run", fixture("valid.json"));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('"hello"');
  });

  test("run --json: versioned success envelope", async () => {
    const result = await cli("run", fixture("valid.json"), "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      status: "succeeded",
      output: "hello",
    });
  });

  test("run: graph failure is exit 1 with empty stdout", async () => {
    const result = await cli("run", fixture("failing.json"));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("doomed");
  });

  test("run --json: versioned failure envelope, exit 1", async () => {
    const result = await cli("run", fixture("failing.json"), "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      status: "failed",
      failures: [{ nodeId: "doomed", cause: { reason: "boom" } }],
    });
  });

  test("run: invalid graph never starts a run, exit 2", async () => {
    const result = await cli("run", fixture("invalid.json"));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });

  test("run: a YAML graph runs like its JSON equivalent", async () => {
    const result = await cli("run", fixture("valid.yaml"), "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      status: "succeeded",
      output: "hello",
    });
  });

  test("graph: a YAML graph compiles to the same plan", async () => {
    const result = await cli("graph", fixture("valid.yaml"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      ["first (constant)", "second (passthrough) <- first", "final: second"]
        .map((line) => `${line}\n`)
        .join(""),
    );
  });

  test("run with a run id explains how to configure PRISM_HOME", async () => {
    const result = await cliWith(
      { prismHome: null },
      "run",
      fixture("valid.json"),
      "--run-id",
      "needs-home",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("PRISM_HOME is not set");
    expect(result.stderr).not.toContain("unexpected internal error");
  });

  test("run --store still requires PRISM_HOME for logs and worktrees", async () => {
    const result = await cliWith(
      { prismHome: null },
      "run",
      fixture("valid.json"),
      "--store",
      join(defaultTestPrismHome, "explicit-runs.db"),
      "--run-id",
      "store-does-not-replace-home",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("PRISM_HOME is not set");
    expect(result.stderr).toContain("even when --store is provided");
  });

  test("beads-dag defaults hydrated work to Greptile review", async () => {
    const root = mkdtempSync(join(tmpdir(), "prism-cli-beads-"));
    try {
      const repo = join(root, "code");
      const prismHome = join(root, "prism-home");
      const beadsRepo = join(prismHome, "beads", "code");
      const out = join(root, "graph.json");
      const bd = join(root, "fake-bd.mjs");
      mkdirSync(repo);
      mkdirSync(beadsRepo, { recursive: true });
      writeFileSync(
        bd,
        `#!/usr/bin/env node
if (process.cwd() !== ${JSON.stringify(realpathSync(beadsRepo))}) {
  process.stderr.write("wrong Beads workspace: " + process.cwd());
  process.exit(9);
}
const command = process.argv[2];
if (command === "export") {
  process.stdout.write([
    JSON.stringify({ id: "bd-a", title: "A", status: "open" }),
    JSON.stringify({ id: "bd-closed", title: "Closed", status: "closed" }),
  ].join("\\n") + "\\n");
} else if (command === "show") {
  process.stdout.write(JSON.stringify([
    {
      id: "bd-a",
      title: "A",
      description: "Hydrated implementation details",
      acceptance_criteria: "Tests pass",
      status: "open",
      labels: ["prism"]
    },
    { id: "bd-closed", title: "Closed", status: "closed" }
  ]));
} else {
  process.exitCode = 2;
}
`,
      );
      chmodSync(bd, 0o755);

      const result = await cliWith(
        { prismHome },
        "beads-dag",
        "--repo",
        repo,
        "--out",
        out,
        "--bd-bin",
        bd,
        "--validation-command",
        "npm test",
        "--no-beads-update",
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(out);
      const graph = JSON.parse(readFileSync(out, "utf8")) as {
        nodes: Record<
          string,
          {
            executor: string;
            config?: {
              value?: { description?: string };
              review?: {
                by?: string;
                minConfidenceScore?: number;
                allowConfidenceFourWithoutActionableFindings?: boolean;
                triggerComment?: string;
              };
              validationCommands?: string[];
            };
          }
        >;
      };
      expect(graph.nodes["context-bd-a"]?.config?.value?.description).toBe(
        "Hydrated implementation details",
      );
      expect(graph.nodes["implement-bd-a"]?.config).toMatchObject({
        review: {
          by: "greptile",
          minConfidenceScore: 5,
          triggerComment: "@greptile review",
        },
        validationCommands: ["npm test"],
      });
      expect(
        graph.nodes["implement-bd-a"]?.config?.review
          ?.allowConfidenceFourWithoutActionableFindings,
      ).toBeUndefined();
      expect(graph.nodes["merge-bd-a"]?.executor).toBe("merge_resolve");
      expect(graph.nodes["implement-bd-closed"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("run registers implement as a Codex executor", async () => {
    const root = mkdtempSync(join(tmpdir(), "prism-cli-agent-registry-"));
    try {
      const graph = join(root, "invalid-implement.json");
      writeFileSync(
        graph,
        JSON.stringify({
          version: 1,
          nodes: {
            task: {
              executor: "implement",
              config: {
                targetBranch: "main",
                review: { by: "claude" },
              },
            },
          },
          finalNode: "task",
        }),
      );
      const result = await cli("run", graph, "--repo", root, "--json");
      expect(result.code).toBe(1);
      const outcome = JSON.parse(result.stdout) as {
        failures: { cause: { code?: string } }[];
      };
      expect(outcome.failures[0]?.cause.code).toBe("INVALID_CONFIG");
      expect(result.stderr).not.toContain("UNKNOWN_EXECUTOR");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prism CLI: persisted runs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "prism-cli-store-"));
  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  let counter = 0;
  function db(): string {
    counter += 1;
    return join(tempDir, `runs-${String(counter)}.db`);
  }

  function runIdFrom(stderr: string): string {
    const match = /^run (.+)$/mu.exec(stderr);
    if (match?.[1] === undefined) {
      throw new Error(`run id missing from stderr: ${stderr}`);
    }
    return match[1];
  }

  test("run --store persists, then inspect reports node states", async () => {
    const store = db();
    const ran = await cli(
      "run",
      fixture("valid.json"),
      "--store",
      store,
      "--run-id",
      "r1",
    );
    expect(ran.code).toBe(0);
    expect(runIdFrom(ran.stderr)).toBe("r1");

    const inspected = await cli("inspect", "r1", "--store", store);
    expect(inspected.code).toBe(0);
    expect(inspected.stdout).toContain("first: succeeded");
    expect(inspected.stdout).toContain("second: succeeded");
    expect(inspected.stdout).toContain("finished: true");
  });

  test("PRISM_HOME persists a generated run id for run, watch, and inspect", async () => {
    const repo = join(tempDir, "default-project");
    const prismHome = join(tempDir, "prism-home");
    mkdirSync(repo);

    const ran = await cliWith(
      { cwd: repo, prismHome },
      "run",
      fixture("valid.json"),
    );
    expect(ran.code).toBe(0);
    const runId = runIdFrom(ran.stderr);
    expect(runId).toMatch(/^run-[0-9a-f-]+$/u);
    expect(
      existsSync(join(prismHome, "store", "default-project", "runs.db")),
    ).toBe(true);

    const watched = await cliWith(
      { cwd: repo, prismHome },
      "watch",
      "--interval",
      "1",
    );
    expect(watched.code).toBe(0);
    expect(watched.stdout).toContain(`run ${runId}: finished`);

    const inspected = await cliWith({ cwd: repo, prismHome }, "inspect", runId);
    expect(inspected.code).toBe(0);
    expect(inspected.stdout).toContain("first: succeeded");
    expect(inspected.stdout).toContain("finished: true");
  });

  test("logs defaults to the latest run and reads durable worker output", async () => {
    const repo = join(tempDir, "logged-project");
    const prismHome = join(tempDir, "logged-prism-home");
    mkdirSync(repo);
    const ran = await cliWith(
      { cwd: repo, prismHome },
      "run",
      fixture("valid.json"),
    );
    expect(ran.code).toBe(0);
    const runId = runIdFrom(ran.stderr);
    const logBackend = createFileLogBackend({
      baseDir: join(prismHome, "logs", "logged-project"),
    });
    const writer = await logBackend.openWriter({
      runId,
      nodeId: "first",
      attempt: 1,
    });
    await writer.write("worker output\n");
    await writer.close();

    const logs = await cliWith({ cwd: repo, prismHome }, "logs");
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain("==> first (attempt 1) <==");
    expect(logs.stdout).toContain("worker output");
  });

  test("logs follows new worker output until the run finishes", async () => {
    const repo = join(tempDir, "follow-project");
    const prismHome = join(tempDir, "follow-prism-home");
    const storePath = join(tempDir, "follow-runs.db");
    mkdirSync(repo);
    const store = createSqliteStore({ path: storePath });
    await store.createRun({
      runId: "follow-run",
      graph: resumableGraph(),
    });
    await store.appendEvents("follow-run", [
      { kind: "node_ready", nodeId: "first" },
      { kind: "node_started", nodeId: "first" },
    ]);

    const following = cliWith(
      { cwd: repo, prismHome },
      "logs",
      "--store",
      storePath,
    );
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 100);
    });
    const logBackend = createFileLogBackend({
      baseDir: join(prismHome, "logs", "follow-project"),
    });
    const writer = await logBackend.openWriter({
      runId: "follow-run",
      nodeId: "first",
      attempt: 1,
    });
    await writer.write("live worker output\n");
    await writer.close();
    await store.finishRun("follow-run", {
      status: "succeeded",
      output: "done",
    });

    const logs = await following;
    await store.close?.();
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain("==> first (attempt 1) <==");
    expect(logs.stdout).toContain("live worker output");
  });

  test("logs tails existing output before following an active run", async () => {
    const repo = join(tempDir, "tail-project");
    const prismHome = join(tempDir, "tail-prism-home");
    const storePath = join(tempDir, "tail-runs.db");
    mkdirSync(repo);
    const store = createSqliteStore({ path: storePath });
    await store.createRun({
      runId: "tail-run",
      graph: resumableGraph(),
    });
    await store.appendEvents("tail-run", [
      { kind: "node_ready", nodeId: "first" },
      { kind: "node_started", nodeId: "first" },
    ]);
    const logBackend = createFileLogBackend({
      baseDir: join(prismHome, "logs", "tail-project"),
    });
    const writer = await logBackend.openWriter({
      runId: "tail-run",
      nodeId: "first",
      attempt: 1,
    });
    await writer.write(
      Array.from(
        { length: 100 },
        (_, index) => `existing line ${String(index + 1)}\n`,
      ).join(""),
    );

    const following = cliWith(
      { cwd: repo, prismHome },
      "logs",
      "tail-run",
      "--store",
      storePath,
    );
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 500);
    });
    await writer.write("new live output\n");
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 600);
    });
    await writer.close();
    await store.finishRun("tail-run", {
      status: "succeeded",
      output: "done",
    });

    const logs = await following;
    await logBackend.close?.();
    await store.close?.();
    expect(logs.code).toBe(0);
    expect(logs.stdout).not.toContain("existing line 1\n");
    expect(logs.stdout).not.toContain("existing line 80\n");
    expect(logs.stdout).toContain("existing line 81\n");
    expect(logs.stdout).toContain("existing line 100\n");
    expect(logs.stdout).toContain("new live output");
  });

  test("logs shows only the current generation after a node reset", async () => {
    const repo = join(tempDir, "reset-logs-project");
    const prismHome = join(tempDir, "reset-logs-prism-home");
    const storePath = join(tempDir, "reset-logs-runs.db");
    mkdirSync(repo);
    const store = createSqliteStore({ path: storePath });
    await store.createRun({
      runId: "reset-logs-run",
      graph: resumableGraph(),
    });
    await store.appendEvents("reset-logs-run", [
      { kind: "node_ready", nodeId: "first" },
      { kind: "node_started", nodeId: "first" },
      {
        kind: "node_failed",
        nodeId: "first",
        failure: { nodeId: "first", cause: "old failure" },
      },
      { kind: "node_reset", nodeId: "first" },
      { kind: "node_ready", nodeId: "first" },
      { kind: "node_started", nodeId: "first" },
      { kind: "node_succeeded", nodeId: "first", output: "done" },
    ]);
    await store.finishRun("reset-logs-run", {
      status: "succeeded",
      output: "done",
    });

    const logBackend = createFileLogBackend({
      baseDir: join(prismHome, "logs", "reset-logs-project"),
    });
    const oldWriter = await logBackend.openWriter({
      runId: "reset-logs-run",
      nodeId: "first",
      attempt: 1,
    });
    await oldWriter.write("old worker output\n");
    await oldWriter.close();
    const currentWriter = await logBackend.openWriter({
      runId: "reset-logs-run",
      nodeId: "first",
      attempt: 1,
    });
    await currentWriter.write("current worker output\n");
    await currentWriter.close();
    await logBackend.close?.();
    await store.close?.();

    const logs = await cliWith(
      { cwd: repo, prismHome },
      "logs",
      "reset-logs-run",
      "--store",
      storePath,
    );
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain("==> first (attempt 1) <==");
    expect(logs.stdout).toContain("current worker output");
    expect(logs.stdout).not.toContain("old worker output");
    expect(logs.stdout).not.toContain("attempt 2");
  });

  test("inspect --json is a versioned envelope", async () => {
    const store = db();
    await cli("run", fixture("valid.json"), "--store", store, "--run-id", "r2");
    const inspected = await cli("inspect", "r2", "--store", store, "--json");
    expect(inspected.code).toBe(0);
    const parsed = JSON.parse(inspected.stdout) as {
      version: number;
      runId: string;
      finished: boolean;
      nodes: { nodeId: string; state: string }[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.runId).toBe("r2");
    expect(parsed.finished).toBe(true);
    expect(parsed.nodes.map((n) => n.state)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });

  test("events lists the persisted event log in order", async () => {
    const store = db();
    await cli("run", fixture("valid.json"), "--store", store, "--run-id", "r3");
    const events = await cli("events", "r3", "--store", store);
    expect(events.code).toBe(0);
    const lines = events.stdout.trim().split("\n");
    expect(lines[0]).toBe("0 node_ready first");
    expect(events.stdout).toContain("node_succeeded second");
  });

  test("events --json preserves full ordered event payloads", async () => {
    const store = db();
    await cli("run", fixture("valid.json"), "--store", store, "--run-id", "r4");
    const result = await cli("events", "r4", "--store", store, "--json");
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      version: number;
      runId: string;
      events: {
        seq: number;
        kind: string;
        nodeId: string;
        output?: unknown;
      }[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.runId).toBe("r4");
    expect(parsed.events.map((event) => event.seq)).toEqual(
      parsed.events.map((_event, index) => index),
    );
    expect(parsed.events.at(-1)).toMatchObject({
      kind: "node_succeeded",
      nodeId: "second",
      output: "hello",
    });
  });

  test("inspect of an unknown run exits 2", async () => {
    const inspected = await cli("inspect", "ghost", "--store", db());
    expect(inspected.code).toBe(2);
    expect(inspected.stdout).toBe("");
  });

  test("inspect without --store explains how to configure PRISM_HOME", async () => {
    const inspected = await cliWith({ prismHome: null }, "inspect", "r1");
    expect(inspected.code).toBe(2);
    expect(inspected.stderr).toContain("PRISM_HOME is not set");
  });

  test("events of an unknown run exits 2", async () => {
    const events = await cli("events", "ghost", "--store", db());
    expect(events.code).toBe(2);
    expect(events.stdout).toBe("");
    expect(events.stderr).toContain("unknown run");
  });

  test("persistent runs without explicit ids receive unique durable ids", async () => {
    const store = db();
    const first = await cli("run", fixture("valid.json"), "--store", store);
    const second = await cli("run", fixture("valid.json"), "--store", store);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const firstId = runIdFrom(first.stderr);
    const secondId = runIdFrom(second.stderr);
    expect(firstId).not.toBe(secondId);
    expect(firstId).toMatch(/^run-/u);
    expect((await cli("inspect", firstId, "--store", store)).code).toBe(0);
    expect((await cli("inspect", secondId, "--store", store)).code).toBe(0);
  });

  test("a duplicate explicit run id is a usage error", async () => {
    const store = db();
    await cli(
      "run",
      fixture("valid.json"),
      "--store",
      store,
      "--run-id",
      "duplicate",
    );
    const duplicate = await cli(
      "run",
      fixture("valid.json"),
      "--store",
      store,
      "--run-id",
      "duplicate",
    );
    expect(duplicate.code).toBe(2);
    expect(duplicate.stdout).toBe("");
    expect(duplicate.stderr).toContain("run already exists");
  });

  test("a persisted failing run reports failed and blocked", async () => {
    const store = db();
    await cli(
      "run",
      fixture("failing.json"),
      "--store",
      store,
      "--run-id",
      "rf",
    );
    const inspected = await cli("inspect", "rf", "--store", store);
    expect(inspected.code).toBe(0);
    expect(inspected.stdout).toContain("doomed: failed");
    expect(inspected.stdout).toContain('failure doomed: {"reason":"boom"}');
  });

  test("status lists persisted runs, most-recent first", async () => {
    const store = db();
    await cli("run", fixture("valid.json"), "--store", store, "--run-id", "s1");
    await cli(
      "run",
      fixture("failing.json"),
      "--store",
      store,
      "--run-id",
      "s2",
    );
    const status = await cli("status", "--store", store);
    expect(status.code).toBe(0);
    const lines = status.stdout.trim().split("\n");
    expect(lines[0]?.startsWith("s2")).toBe(true);
    expect(lines[1]?.startsWith("s1")).toBe(true);
    expect(status.stdout).toContain("finished");
  });

  test("status --json is a versioned envelope", async () => {
    const store = db();
    await cli("run", fixture("valid.json"), "--store", store, "--run-id", "s3");
    const status = await cli("status", "--store", store, "--json");
    expect(status.code).toBe(0);
    const parsed = JSON.parse(status.stdout) as {
      version: number;
      runs: { runId: string; finished: boolean }[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.runs.map((run) => run.runId)).toContain("s3");
  });

  test("status without --store explains how to configure PRISM_HOME", async () => {
    const status = await cliWith({ prismHome: null }, "status");
    expect(status.code).toBe(2);
    expect(status.stderr).toContain("PRISM_HOME is not set");
  });

  test("watch emits a finished JSON snapshot and exits successfully", async () => {
    const store = db();
    await cli(
      "run",
      fixture("valid.json"),
      "--store",
      store,
      "--run-id",
      "watch-ok",
    );
    const watched = await cli(
      "watch",
      "watch-ok",
      "--store",
      store,
      "--json",
      "--interval",
      "1",
    );
    expect(watched.code).toBe(0);
    const snapshot = JSON.parse(watched.stdout) as {
      version: number;
      runId: string;
      finished: boolean;
      nodes: { state: string }[];
    };
    expect(snapshot.version).toBe(1);
    expect(snapshot.runId).toBe("watch-ok");
    expect(snapshot.finished).toBe(true);
    expect(snapshot.nodes.every((node) => node.state === "succeeded")).toBe(
      true,
    );
  });

  test("watch exits 1 when the persisted run failed", async () => {
    const store = db();
    await cli(
      "run",
      fixture("failing.json"),
      "--store",
      store,
      "--run-id",
      "watch-failed",
    );
    const watched = await cli("watch", "watch-failed", "--store", store);
    expect(watched.code).toBe(1);
    expect(watched.stdout).toContain("doomed: failed");
    expect(watched.stdout).toContain('failure doomed: {"reason":"boom"}');
  });

  test("watch rejects unknown runs and invalid intervals", async () => {
    const unknown = await cli("watch", "ghost", "--store", db());
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("unknown run");

    const invalid = await cli(
      "watch",
      "ghost",
      "--store",
      db(),
      "--interval",
      "0",
    );
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("Usage:");
  });

  test("resume of a finished run reports its recorded outcome", async () => {
    const store = db();
    await cli(
      "run",
      fixture("valid.json"),
      "--store",
      store,
      "--run-id",
      "res1",
    );
    const resumed = await cli("resume", "res1", "--store", store, "--json");
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout)).toEqual({
      version: 1,
      status: "succeeded",
      output: "hello",
    });
  });

  test("resume continues a partially completed durable run", async () => {
    const path = db();
    const store = createSqliteStore({ path });
    await store.createRun({
      runId: "interrupted",
      graph: resumableGraph(),
    });
    await store.appendEvents("interrupted", [
      { kind: "node_ready", nodeId: "first" },
      { kind: "node_started", nodeId: "first" },
      { kind: "node_succeeded", nodeId: "first", output: "hello" },
      { kind: "node_ready", nodeId: "second" },
    ]);
    await store.close?.();

    const resumed = await cli(
      "resume",
      "interrupted",
      "--store",
      path,
      "--json",
    );
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout)).toEqual({
      version: 1,
      status: "succeeded",
      output: "hello",
    });

    const inspected = await cli(
      "inspect",
      "interrupted",
      "--store",
      path,
      "--json",
    );
    expect(inspected.code).toBe(0);
    const inspection = JSON.parse(inspected.stdout) as {
      finished: boolean;
      nodes: { state: string }[];
    };
    expect(inspection.finished).toBe(true);
    expect(inspection.nodes.map((node) => node.state)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });

  test("resume of a finished failing run reports failed, exit 1", async () => {
    const store = db();
    await cli(
      "run",
      fixture("failing.json"),
      "--store",
      store,
      "--run-id",
      "resf",
    );
    const resumed = await cli("resume", "resf", "--store", store, "--json");
    expect(resumed.code).toBe(1);
    expect((JSON.parse(resumed.stdout) as { status: string }).status).toBe(
      "failed",
    );
  });

  test("resume of an unknown run exits 2", async () => {
    const resumed = await cli("resume", "ghost", "--store", db());
    expect(resumed.code).toBe(2);
    expect(resumed.stdout).toBe("");
    expect(resumed.stderr).toContain("cannot resume");
  });

  test("resume without --store explains how to configure PRISM_HOME", async () => {
    const resumed = await cliWith({ prismHome: null }, "resume", "res1");
    expect(resumed.code).toBe(2);
    expect(resumed.stderr).toContain("PRISM_HOME is not set");
  });

  test("resume --store still requires PRISM_HOME for logs and worktrees", async () => {
    const resumed = await cliWith(
      { prismHome: null },
      "resume",
      "res1",
      "--store",
      db(),
    );
    expect(resumed.code).toBe(2);
    expect(resumed.stderr).toContain("PRISM_HOME is not set");
    expect(resumed.stderr).toContain("even when --store is provided");
  });

  test("rerun-node resets a node and downstream, then resume re-runs them", async () => {
    const store = db();
    await cli("run", fixture("valid.json"), "--store", store, "--run-id", "rr");
    // both nodes are succeeded; reset the root + downstream
    const reset = await cli(
      "rerun-node",
      "rr",
      "first",
      "--store",
      store,
      "--json",
    );
    expect(reset.code).toBe(0);
    expect(JSON.parse(reset.stdout)).toEqual({
      version: 1,
      runId: "rr",
      reset: "first",
      includeDownstream: true,
    });

    const afterReset = await cli("inspect", "rr", "--store", store);
    expect(afterReset.stdout).toContain("first: pending");
    expect(afterReset.stdout).toContain("second: pending");

    const resumed = await cli("resume", "rr", "--store", store, "--json");
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout)).toEqual({
      version: 1,
      status: "succeeded",
      output: "hello",
    });
  });

  test("signal resets a single node, leaving dependents intact", async () => {
    const store = db();
    await cli("run", fixture("valid.json"), "--store", store, "--run-id", "sg");
    const signalled = await cli("signal", "sg", "first", "--store", store);
    expect(signalled.code).toBe(0);

    const inspected = await cli("inspect", "sg", "--store", store);
    expect(inspected.stdout).toContain("first: pending");
    expect(inspected.stdout).toContain("second: succeeded");
  });

  test("abort forces a stuck run to cancelled+finished", async () => {
    const path = db();
    const store = createSqliteStore({ path });
    // Seed a run stuck with a node mid-flight (started, never settled).
    await store.createRun({ runId: "stuck", graph: resumableGraph() });
    await store.appendEvents("stuck", [
      { kind: "node_ready", nodeId: "first" },
      { kind: "node_started", nodeId: "first" },
    ]);
    await store.close?.();

    const aborted = await cli("abort", "stuck", "--store", path);
    expect(aborted.code).toBe(0);

    const inspected = await cli("inspect", "stuck", "--store", path);
    expect(inspected.stdout).toContain("first: cancelled");
    expect(inspected.stdout).toContain("finished: true");
  });

  test("signal of an unknown node exits 2", async () => {
    const store = db();
    await cli("run", fixture("valid.json"), "--store", store, "--run-id", "s2");
    const signalled = await cli("signal", "s2", "ghost", "--store", store);
    expect(signalled.code).toBe(2);
    expect(signalled.stderr).toContain("cannot signal");
  });

  test("signal requires both run and node positionals", async () => {
    const missing = await cli("signal", "onlyrun", "--store", db());
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Usage:");
  });
});
