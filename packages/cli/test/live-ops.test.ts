import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  inspectRun,
  parseGraph,
} from "@rsetia/prism";
import type {
  CompiledGraph,
  ExecutorDefinition,
  NodeExecutionOutcome,
  RunStore,
} from "@rsetia/prism";
import { createFileLogBackend, createSqliteStore } from "@rsetia/prism/node";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Operator flows that span processes: a coordinator running in this test
 * process and the BUILT prism CLI acting on the same SQLite store, the way
 * an operator's terminal acts on a run another terminal is driving.
 */
const CLI_PATH = fileURLToPath(new URL("../dist/main.js", import.meta.url));
if (!existsSync(CLI_PATH)) {
  throw new Error("CLI is not built — run `npm run build` first");
}
const execFileAsync = promisify(execFile);
const tempDir = mkdtempSync(join(tmpdir(), "prism-live-ops-"));
const prismHome = join(tempDir, "prism-home");
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(
  options: { readonly cwd?: string },
  ...args: readonly string[]
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, ...args],
      {
        timeout: 20_000,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: { ...process.env, PRISM_HOME: prismHome },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : -1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

let counter = 0;
function db(): string {
  counter += 1;
  return join(tempDir, `runs-${String(counter)}.db`);
}

function buildGraph(definition: unknown): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  probe: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const blockerOutcome: NodeExecutionOutcome = {
  status: "failed",
  cause: {
    code: "WORKER_FAILURE_ADJUDICATED",
    error:
      "B4 remains blocked at unchanged head a949: frozen CoreCommand lacks AgentUpdate ingress.\nThe bead requires stopping and reporting contract gaps.",
    reason: "review iteration budget exhausted (8)",
    state: {
      pullRequest: {
        number: 6,
        url: "https://github.com/example/repo/pull/6",
        state: "open",
      },
    },
  },
  failureClass: "semantic_failed",
};

const graph = (): CompiledGraph =>
  buildGraph({
    version: 1,
    nodes: {
      impl: { executor: "impl" },
      merge: { executor: "passthrough", dependsOn: ["impl"] },
      slow: { executor: "slow" },
      final: {
        executor: "constant",
        config: { value: "all-done" },
        dependsOn: ["merge", "slow"],
      },
    },
    finalNode: "final",
  });

function liveCoordinator(store: RunStore, runId: string) {
  let implCalls = 0;
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const impl: ExecutorDefinition = {
    name: "impl",
    execute: () => {
      implCalls += 1;
      return implCalls === 1
        ? blockerOutcome
        : { status: "succeeded", output: "fixed" };
    },
  };
  const slow: ExecutorDefinition = {
    name: "slow",
    execute: async () => {
      await opened;
      return { status: "succeeded", output: "slow" };
    },
  };
  const engine = createEngine({
    store,
    registry: createExecutorRegistry([...builtinExecutors, impl, slow]),
    maxConcurrency: 4,
    adminPollIntervalMs: 20,
  });
  const handle = engine.run(graph(), { runId });
  return { handle, release: () => release(), implCalls: () => implCalls };
}

async function stateOf(
  store: RunStore,
  runId: string,
  nodeId: string,
): Promise<string | undefined> {
  if ((await store.getRun(runId)) === undefined) return undefined;
  return (await inspectRun(store, runId)).nodes.find((n) => n.nodeId === nodeId)
    ?.state;
}

describe("prism CLI: one run, operator in the loop", () => {
  test("needs input renders apart from failures, with the PR and next action", async () => {
    const path = db();
    const store = createSqliteStore({ path });
    const coordinator = liveCoordinator(store, "blocked-run");
    await waitFor(
      async () => (await stateOf(store, "blocked-run", "merge")) === "blocked",
      "the blocker to stop merge",
    );

    const status = await cli({}, "status", "--store", path);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("blocked-run\trunning");
    expect(status.stdout).toContain(
      "⏸ needs input impl: B4 remains blocked at unchanged head a949: frozen CoreCommand lacks AgentUpdate ingress. · https://github.com/example/repo/pull/6",
    );
    expect(status.stdout).toContain(
      "→ resolve the blocker, then: prism rerun-node blocked-run impl",
    );

    const inspected = await cli({}, "inspect", "blocked-run", "--store", path);
    expect(inspected.stdout).toContain("impl: failed");
    expect(inspected.stdout).toContain("needs input impl: B4 remains blocked");
    expect(inspected.stdout).not.toContain("failure impl:");

    const json = await cli(
      {},
      "inspect",
      "blocked-run",
      "--store",
      path,
      "--json",
    );
    const details = (
      JSON.parse(json.stdout) as {
        failureDetails: { nodeId: string; disposition: string }[];
      }
    ).failureDetails;
    expect(details).toEqual([
      expect.objectContaining({ nodeId: "impl", disposition: "needs_input" }),
    ]);

    // The documented way on: rerun-node, applied by the LIVE coordinator,
    // so the node re-runs inside this same run.
    const rerun = await cli(
      {},
      "rerun-node",
      "blocked-run",
      "impl",
      "--store",
      path,
      "--json",
    );
    expect(rerun.code).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({
      appliedBy: "live",
      resetNodeIds: ["impl", "merge", "final"],
    });
    expect(rerun.stderr).toContain("applied by the live coordinator");

    await waitFor(
      async () =>
        (await stateOf(store, "blocked-run", "merge")) === "succeeded",
      "impl and merge to re-run in place",
    );
    coordinator.release();
    await expect(coordinator.handle.result).resolves.toEqual({
      status: "succeeded",
      output: "all-done",
    });
    expect(coordinator.implCalls()).toBe(2);
    expect((await store.listRuns()).map((run) => run.runId)).toEqual([
      "blocked-run",
    ]);
    await store.close?.();
  });

  test("a live request against running work is rejected with the reason", async () => {
    const path = db();
    const store = createSqliteStore({ path });
    const coordinator = liveCoordinator(store, "busy-run");
    await waitFor(
      async () => (await stateOf(store, "busy-run", "slow")) === "running",
      "slow to start",
    );
    const signalled = await cli(
      {},
      "signal",
      "busy-run",
      "slow",
      "--store",
      path,
    );
    expect(signalled.code).toBe(2);
    expect(signalled.stderr).toContain('node "slow" is running');
    coordinator.release();
    await coordinator.handle.result;
    await store.close?.();
  });

  test("an unresponsive coordinator times out and the request is withdrawn", async () => {
    const path = db();
    const store = createSqliteStore({ path });
    await store.createRun({ runId: "old-coordinator", graph: graph() });
    // A coordinator from an older prism holds the run but never reads the queue.
    await store.acquireCoordinatorLease("old-coordinator", "legacy", 60_000);

    const signalled = await cli(
      {},
      "signal",
      "old-coordinator",
      "impl",
      "--store",
      path,
      "--timeout",
      "300",
    );
    expect(signalled.code).toBe(2);
    expect(signalled.stderr).toContain(
      "did not apply the request within 300ms",
    );
    expect(await store.listPendingAdminRequests?.("old-coordinator")).toEqual(
      [],
    );
    await store.close?.();
  });

  test("flag validation", async () => {
    const path = db();
    const badRetries = await cli(
      {},
      "run",
      "graph.json",
      "--store",
      path,
      "--max-transient-retries",
      "-1",
    );
    expect(badRetries.code).toBe(2);
    expect(badRetries.stderr).toContain("Usage:");
    const timeoutElsewhere = await cli(
      {},
      "inspect",
      "x",
      "--store",
      path,
      "--timeout",
      "5",
    );
    expect(timeoutElsewhere.code).toBe(2);
    expect(timeoutElsewhere.stderr).toContain("Usage:");
    const retriesOnRead = await cli(
      {},
      "status",
      "--store",
      path,
      "--max-transient-retries",
      "1",
    );
    expect(retriesOnRead.code).toBe(2);
  });
});

describe("prism CLI: several unfinished runs", () => {
  test("watch and logs show every unfinished run, not just the newest", async () => {
    const repo = join(tempDir, "multi-project");
    mkdirSync(repo, { recursive: true });
    const path = db();
    const store = createSqliteStore({ path });
    const simple = buildGraph({
      version: 1,
      nodes: { first: { executor: "constant", config: { value: "x" } } },
      finalNode: "first",
    });
    for (const runId of ["run-aaaa1111-older", "run-bbbb2222-newer"]) {
      await store.createRun({ runId, graph: simple });
      await store.appendEvents(runId, [
        { kind: "node_ready", nodeId: "first" },
        { kind: "node_started", nodeId: "first" },
      ]);
    }
    const logBackend = createFileLogBackend({
      baseDir: join(prismHome, "logs", "multi-project"),
    });
    for (const [runId, text] of [
      ["run-aaaa1111-older", "older output\n"],
      ["run-bbbb2222-newer", "newer output\n"],
    ] as const) {
      const writer = await logBackend.openWriter({
        runId,
        nodeId: "first",
        attempt: 1,
      });
      await writer.write(text);
      await writer.close();
    }

    const watching = cli(
      { cwd: repo },
      "watch",
      "--store",
      path,
      "--interval",
      "50",
    );
    const following = cli({ cwd: repo }, "logs", "--store", path);
    await sleep(400);
    for (const runId of ["run-aaaa1111-older", "run-bbbb2222-newer"]) {
      await store.appendEvents(runId, [
        { kind: "node_succeeded", nodeId: "first", output: "x" },
      ]);
      await store.finishRun(runId, { status: "succeeded", output: "x" });
    }

    const watched = await watching;
    expect(watched.code).toBe(0);
    expect(watched.stdout).toContain("run run-aaaa1111-older: finished");
    expect(watched.stdout).toContain("run run-bbbb2222-newer: finished");

    const logs = await following;
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain("[aaaa1111] older output");
    expect(logs.stdout).toContain("[bbbb2222] newer output");
    expect(logs.stdout).toContain("[aaaa1111] ==> first (attempt 1) <==");
    await store.close?.();
  });
});
