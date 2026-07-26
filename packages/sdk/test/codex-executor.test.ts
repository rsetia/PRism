import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  parseGraph,
} from "../src/index.js";
import type {
  CompiledGraph,
  ExecutionContext,
  JsonValue,
} from "../src/index.js";
import { createCodexExecutor } from "../src/node/index.js";
import type {
  CodexEngine,
  CodexExecutionInput,
  WorkerResult,
  WorkspaceHandle,
  WorkspaceProvisioner,
} from "../src/node/index.js";

const tempDir = mkdtempSync(join(tmpdir(), "prism-codex-exec-"));
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** A CodexEngine that records its input and returns a canned result. */
function fakeEngine(result: WorkerResult): {
  engine: CodexEngine;
  inputs: CodexExecutionInput[];
} {
  const inputs: CodexExecutionInput[] = [];
  const engine: CodexEngine = {
    execute(input) {
      inputs.push(input);
      return Promise.resolve(result);
    },
  };
  return { engine, inputs };
}

/** A provisioner that hands back a temp dir and records provision/release. */
function fakeProvisioner(): {
  provisioner: WorkspaceProvisioner;
  provisioned: string[];
  released: string[];
} {
  const provisioned: string[] = [];
  const released: string[] = [];
  const provisioner: WorkspaceProvisioner = {
    provision(input) {
      const dir = mkdtempSync(join(tempDir, `ws-${input.nodeId}-`));
      provisioned.push(dir);
      return Promise.resolve({ dir, branch: `b/${input.nodeId}` });
    },
    release(handle: WorkspaceHandle) {
      released.push(handle.dir);
      return Promise.resolve();
    },
  };
  return { provisioner, provisioned, released };
}

const implementConfig = {
  workItem: { provider: "beads", id: "MC-1" },
  targetBranch: "main",
  review: { by: "none" },
};

function graphWith(executor: string, config: unknown): CompiledGraph {
  const parsed = parseGraph({
    version: 1,
    nodes: { work: { executor, config } },
    finalNode: "work",
  });
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

function run(
  graph: CompiledGraph,
  executor: ReturnType<typeof createCodexExecutor>,
) {
  return createEngine({
    store: createMemoryStore(),
    registry: createExecutorRegistry([executor]),
  }).run(graph);
}

function context(
  inputs: readonly JsonValue[] = [],
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  return {
    runId: "direct-run",
    nodeId: "direct-node",
    kind: "task",
    attempt: 1,
    inputs,
    config: implementConfig,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("createCodexExecutor", () => {
  test("runs an implement node and maps a succeeded result", async () => {
    const { engine, inputs } = fakeEngine({
      status: "succeeded",
      output: { branch: "prism/mc-1", pr_number: 5 },
    });
    const executor = createCodexExecutor({
      name: "implement",
      engine,
      cwd: tempDir,
      nodeDirBase: tempDir,
    });
    const outcome = await run(graphWith("implement", implementConfig), executor)
      .result;
    expect(outcome).toEqual({
      status: "succeeded",
      output: { branch: "prism/mc-1", pr_number: 5 },
    });

    // The engine received the implement contract (git + GitHub permissions).
    const input = inputs[0];
    expect(input?.contract.allowsGitHubIo).toBe(true);
    expect(input?.spec.executor).toBe("implement");
    // spec.json was written into the node dir the engine was given.
    expect(existsSync(join(input?.nodeDir ?? "", "spec.json"))).toBe(true);
    const written = JSON.parse(
      readFileSync(join(input?.nodeDir ?? "", "spec.json"), "utf8"),
    ) as { executor: string };
    expect(written.executor).toBe("implement");
  });

  test("maps a failed worker result to a classified node failure", async () => {
    const { engine } = fakeEngine({
      status: "failed",
      error: "hit max iterations",
      failureClass: "semantic_failed",
    });
    const executor = createCodexExecutor({
      name: "implement",
      engine,
      cwd: tempDir,
      nodeDirBase: tempDir,
    });
    const outcome = await run(graphWith("implement", implementConfig), executor)
      .result;
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failures[0]?.failureClass).toBe("semantic_failed");
    }
  });

  test("provisions a worktree and releases it", async () => {
    const { engine, inputs } = fakeEngine({
      status: "succeeded",
      output: null,
    });
    const { provisioner, provisioned, released } = fakeProvisioner();
    const executor = createCodexExecutor({
      name: "implement",
      engine,
      provisioner,
      nodeDirBase: tempDir,
    });
    await run(graphWith("implement", implementConfig), executor).result;
    expect(provisioned).toHaveLength(1);
    expect(released).toEqual(provisioned);
    // The engine ran in the provisioned worktree.
    expect(inputs[0]?.worktreeDir).toBe(provisioned[0]);
  });

  test("preflight rejects an invalid implement config", async () => {
    const { engine } = fakeEngine({ status: "succeeded", output: null });
    const executor = createCodexExecutor({
      name: "implement",
      engine,
      cwd: tempDir,
      nodeDirBase: tempDir,
    });
    // Missing workItem.id — validateConfig should fail the run at preflight.
    const outcome = await run(
      graphWith("implement", { targetBranch: "main", review: { by: "none" } }),
      executor,
    ).result;
    expect(outcome.status).toBe("failed");
  });

  test("dispatches merge_resolve to its own contract", async () => {
    const { engine, inputs } = fakeEngine({
      status: "succeeded",
      output: null,
    });
    const executor = createCodexExecutor({
      name: "merge_resolve",
      engine,
      cwd: tempDir,
      nodeDirBase: tempDir,
    });
    await run(
      graphWith("merge_resolve", {
        targetBranch: "main",
        sourceBranchFrom: "implement-mc-1",
      }),
      executor,
    ).result;
    expect(inputs[0]?.spec.executor).toBe("merge_resolve");
    expect(inputs[0]?.contract.allowsGitMutation).toBe(true);
  });

  test("shapes zero, one, and many upstream outputs into the worker spec", async () => {
    const { engine, inputs } = fakeEngine({
      status: "succeeded",
      output: null,
    });
    const executor = createCodexExecutor({
      name: "implement",
      engine,
      cwd: tempDir,
      nodeDirBase: tempDir,
    });

    await executor.execute(context());
    await executor.execute(context([{ branch: "feature-a" }]));
    await executor.execute(context(["a", "b"]));

    expect(inputs.map((input) => input.spec.input)).toEqual([
      null,
      { branch: "feature-a" },
      ["a", "b"],
    ]);
  });

  test("passes complete context fields and the abort signal to the engine", async () => {
    const { engine, inputs } = fakeEngine({
      status: "succeeded",
      output: null,
    });
    const signal = new AbortController().signal;
    const executor = createCodexExecutor({
      name: "implement",
      engine,
      cwd: tempDir,
      nodeDirBase: tempDir,
    });
    await executor.execute(
      context([], {
        runId: "run-fields",
        nodeId: "node-fields",
        attempt: 3,
        signal,
      }),
    );
    expect(inputs[0]?.spec).toMatchObject({
      runId: "run-fields",
      nodeId: "node-fields",
      kind: "task",
      executor: "implement",
      attempt: 3,
      config: implementConfig,
    });
    expect(inputs[0]?.signal).toBe(signal);
  });

  test("rejects an unknown executor name at construction", () => {
    const { engine } = fakeEngine({ status: "succeeded", output: null });
    expect(() => createCodexExecutor({ name: "constant", engine })).toThrow(
      "implement",
    );
  });

  test("returns invalid and throwing input shapers as validation failures", async () => {
    const invalidEngine = fakeEngine({ status: "succeeded", output: null });
    const invalid = createCodexExecutor({
      name: "implement",
      engine: invalidEngine.engine,
      nodeDirBase: tempDir,
      shapeInput: () => BigInt(1) as unknown as JsonValue,
    });
    const invalidOutcome = await invalid.execute(context());
    expect(invalidOutcome).toMatchObject({
      status: "failed",
      failureClass: "validation_failed",
    });
    expect(invalidEngine.inputs).toHaveLength(0);

    const throwing = createCodexExecutor({
      name: "implement",
      engine: invalidEngine.engine,
      nodeDirBase: tempDir,
      shapeInput() {
        throw new Error("could not shape");
      },
    });
    const throwingOutcome = await throwing.execute(context());
    expect(throwingOutcome).toMatchObject({
      status: "failed",
      failureClass: "validation_failed",
    });
  });

  test("returns a contract-builder error before provisioning", async () => {
    const { engine } = fakeEngine({ status: "succeeded", output: null });
    const { provisioner, provisioned } = fakeProvisioner();
    const executor = createCodexExecutor({
      name: "implement",
      engine,
      provisioner,
      nodeDirBase: tempDir,
      buildContract() {
        throw new Error("bad contract config");
      },
    });
    const outcome = await executor.execute(context());
    expect(outcome).toMatchObject({
      status: "failed",
      failureClass: "validation_failed",
    });
    expect(provisioned).toHaveLength(0);
  });

  test("maps a thrown engine error to transient infrastructure and releases", async () => {
    const engine: CodexEngine = {
      execute() {
        return Promise.reject(new Error("codex crashed"));
      },
    };
    const { provisioner, released } = fakeProvisioner();
    const executor = createCodexExecutor({
      name: "implement",
      engine,
      provisioner,
      nodeDirBase: tempDir,
    });
    const outcome = await executor.execute(context());
    expect(outcome).toMatchObject({
      status: "failed",
      failureClass: "transient_infra",
    });
    expect(released).toHaveLength(1);
  });

  test("maps provisioning and release errors to transient infrastructure", async () => {
    const { engine } = fakeEngine({ status: "succeeded", output: null });
    const cannotProvision: WorkspaceProvisioner = {
      provision() {
        return Promise.reject(new Error("no workspace"));
      },
      release() {
        return Promise.resolve();
      },
    };
    const provisionOutcome = await createCodexExecutor({
      name: "implement",
      engine,
      provisioner: cannotProvision,
      nodeDirBase: tempDir,
    }).execute(context());
    expect(provisionOutcome).toMatchObject({
      status: "failed",
      failureClass: "transient_infra",
    });

    const cannotRelease: WorkspaceProvisioner = {
      provision() {
        return Promise.resolve({ dir: tempDir });
      },
      release() {
        return Promise.reject(new Error("release failed"));
      },
    };
    const releaseOutcome = await createCodexExecutor({
      name: "implement",
      engine,
      provisioner: cannotRelease,
      nodeDirBase: tempDir,
    }).execute(context());
    expect(releaseOutcome).toMatchObject({
      status: "failed",
      failureClass: "transient_infra",
    });
  });

  test("cleans an implicit protocol directory after execution", async () => {
    const { engine, inputs } = fakeEngine({
      status: "succeeded",
      output: null,
    });
    const executor = createCodexExecutor({
      name: "implement",
      engine,
      cwd: tempDir,
    });
    await executor.execute(context());
    expect(inputs[0]?.nodeDir).toBeDefined();
    expect(existsSync(inputs[0]?.nodeDir ?? "")).toBe(false);
  });
});
