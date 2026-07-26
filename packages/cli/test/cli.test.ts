import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileGraph, parseGraph } from "@rsetia/prism";
import type { CompiledGraph } from "@rsetia/prism";
import { createSqliteStore } from "@rsetia/prism/node";
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
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, ...args],
      { timeout: 10_000 },
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

  test("inspect without --store is a usage error", async () => {
    const inspected = await cli("inspect", "r1");
    expect(inspected.code).toBe(2);
    expect(inspected.stderr).toContain("Usage:");
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

  test("status without --store is a usage error", async () => {
    const status = await cli("status");
    expect(status.code).toBe(2);
    expect(status.stderr).toContain("Usage:");
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

  test("resume without --store is a usage error", async () => {
    const resumed = await cli("resume", "res1");
    expect(resumed.code).toBe(2);
    expect(resumed.stderr).toContain("Usage:");
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
