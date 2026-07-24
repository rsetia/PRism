import { describe, expect, test } from "vitest";
import {
  createBeadsUpdateExecutor,
  createMergePrExecutor,
  parseBeadsUpdateConfig,
  parseMergePrConfig,
} from "../src/node/index.js";
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions,
} from "../src/node/index.js";
import type { ExecutionContext, JsonValue } from "../src/index.js";

interface Recorded {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: RunCommandOptions;
}

interface Stub {
  readonly match: string;
  readonly result: CommandResult;
}

/** A CommandRunner that records calls and answers by arg-substring match. */
function fakeRunner(stubs: readonly Stub[]): {
  runner: CommandRunner;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const runner: CommandRunner = {
    run(command, args, options) {
      calls.push({
        command,
        args,
        ...(options === undefined ? {} : { options }),
      });
      const line = args.join(" ");
      const stub = stubs.find((s) => line.includes(s.match));
      return Promise.resolve(
        stub?.result ?? { exitCode: 0, stdout: "", stderr: "" },
      );
    },
  };
  return { runner, calls };
}

function ctx(
  config: JsonValue,
  inputs: readonly unknown[] = [],
): ExecutionContext {
  return {
    runId: "r",
    nodeId: "n",
    kind: "task",
    attempt: 1,
    inputs,
    config,
    signal: new AbortController().signal,
  };
}

describe("parseMergePrConfig", () => {
  test("extracts a valid config with default merge method", () => {
    const parsed = parseMergePrConfig({
      targetBranch: "main",
      sourceBranch: "feature-x",
      validationCommands: ["npm test"],
    });
    expect(parsed.targetBranch).toBe("main");
    expect(parsed.sourceBranch).toBe("feature-x");
    expect(parsed.mergeMethod).toBe("squash");
    expect(parsed.validationCommands).toEqual(["npm test"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.validationCommands)).toBe(true);
  });

  test("rejects a missing targetBranch", () => {
    expect(() => parseMergePrConfig({})).toThrow("config.targetBranch");
  });

  test("rejects an unknown merge method", () => {
    expect(() =>
      parseMergePrConfig({ targetBranch: "main", mergeMethod: "octopus" }),
    ).toThrow("config.mergeMethod");
  });

  test.each([
    [{ targetBranch: "main", sourceBranch: "" }, "config.sourceBranch"],
    [
      { targetBranch: "main", validationCommands: ["npm test", 4] },
      "config.validationCommands[1]",
    ],
    [null, "config"],
  ])("rejects malformed config %#", (config, errorField) => {
    expect(() => parseMergePrConfig(config as JsonValue)).toThrow(errorField);
  });
});

describe("createMergePrExecutor", () => {
  test("merges an existing PR through gh and succeeds", async () => {
    const { runner, calls } = fakeRunner([
      {
        match: "pr list",
        result: { exitCode: 0, stdout: '[{"number":42}]', stderr: "" },
      },
      { match: "pr merge", result: { exitCode: 0, stdout: "", stderr: "" } },
    ]);
    const executor = createMergePrExecutor({ runner });
    const outcome = await executor.execute(
      ctx({ targetBranch: "main", sourceBranch: "feature-x" }),
    );
    expect(outcome).toEqual({
      status: "succeeded",
      output: { branch: "feature-x", prNumber: 42, merged: true },
    });
    expect(calls.at(-1)?.args).toEqual(["pr", "merge", "42", "--squash"]);
    expect(calls.every((call) => call.options?.signal !== undefined)).toBe(
      true,
    );
  });

  test("creates a missing PR and merges the number from its URL", async () => {
    const { runner, calls } = fakeRunner([
      {
        match: "pr list",
        result: { exitCode: 0, stdout: "[]", stderr: "" },
      },
      {
        match: "pr create",
        result: {
          exitCode: 0,
          stdout: "https://github.com/acme/repo/pull/19\n",
          stderr: "",
        },
      },
    ]);
    const outcome = await createMergePrExecutor({ runner }).execute(
      ctx({ targetBranch: "main", sourceBranch: "feature-new" }),
    );
    expect(outcome).toEqual({
      status: "succeeded",
      output: { branch: "feature-new", prNumber: 19, merged: true },
    });
    expect(calls.map((call) => call.args[1])).toEqual([
      "list",
      "create",
      "merge",
    ]);
  });

  test("classifies a merge conflict as merge_conflict", async () => {
    const { runner } = fakeRunner([
      {
        match: "pr list",
        result: { exitCode: 0, stdout: '[{"number":42}]', stderr: "" },
      },
      {
        match: "pr merge",
        result: { exitCode: 1, stdout: "", stderr: "not mergeable: conflicts" },
      },
    ]);
    const executor = createMergePrExecutor({ runner });
    const outcome = await executor.execute(
      ctx({ targetBranch: "main", sourceBranch: "feature-x" }),
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failureClass).toBe("merge_conflict");
    }
  });

  test("derives the source branch from an upstream input", async () => {
    const { runner, calls } = fakeRunner([
      {
        match: "pr list",
        result: { exitCode: 0, stdout: '[{"number":7}]', stderr: "" },
      },
    ]);
    const executor = createMergePrExecutor({ runner });
    await executor.execute(
      ctx({ targetBranch: "main" }, [
        { metadata: { branch: "feat-from-upstream" } },
      ]),
    );
    expect(
      calls.some((c) => c.args.join(" ").includes("feat-from-upstream")),
    ).toBe(true);
  });

  test("derives a source branch from a string or direct branch property", async () => {
    const { runner, calls } = fakeRunner([
      {
        match: "pr list",
        result: { exitCode: 0, stdout: '[{"number":7}]', stderr: "" },
      },
    ]);
    const executor = createMergePrExecutor({ runner });
    await executor.execute(ctx({ targetBranch: "main" }, ["feat-as-text"]));
    await executor.execute(
      ctx({ targetBranch: "main" }, [{ branch: "feat-direct" }]),
    );
    const listCalls = calls.filter((call) => call.args[1] === "list");
    expect(listCalls[0]?.args).toContain("feat-as-text");
    expect(listCalls[1]?.args).toContain("feat-direct");
  });

  test("fails as validation_failed when no source branch is resolvable", async () => {
    const { runner } = fakeRunner([]);
    const executor = createMergePrExecutor({ runner });
    const outcome = await executor.execute(ctx({ targetBranch: "main" }));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failureClass).toBe("validation_failed");
    }
  });

  test("exposes validateConfig", () => {
    const executor = createMergePrExecutor();
    expect(() => executor.validateConfig?.({})).toThrow();
  });

  test("runs validation commands without a shell and classifies failures", async () => {
    const { runner, calls } = fakeRunner([
      {
        match: "pr list",
        result: { exitCode: 0, stdout: '[{"number":42}]', stderr: "" },
      },
      {
        match: "run test unit",
        result: { exitCode: 2, stdout: "", stderr: "tests failed" },
      },
    ]);
    const outcome = await createMergePrExecutor({
      runner,
      cwd: "/repo",
    }).execute(
      ctx({
        targetBranch: "main",
        sourceBranch: "feature-x",
        validationCommands: ['npm run "test unit"'],
      }),
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failureClass).toBe("validation_failed");
    }
    expect(calls[1]).toMatchObject({
      command: "npm",
      args: ["run", "test unit"],
      options: { cwd: "/repo" },
    });
    expect(calls.some((call) => call.args[1] === "merge")).toBe(false);
  });

  test("classifies gh lookup and launch failures as transient infrastructure", async () => {
    const lookup = fakeRunner([
      {
        match: "pr list",
        result: { exitCode: 1, stdout: "", stderr: "network unavailable" },
      },
    ]);
    const lookupOutcome = await createMergePrExecutor({
      runner: lookup.runner,
    }).execute(ctx({ targetBranch: "main", sourceBranch: "feature-x" }));
    expect(lookupOutcome).toMatchObject({
      status: "failed",
      failureClass: "transient_infra",
    });

    const throwingRunner: CommandRunner = {
      run() {
        return Promise.reject(new Error("gh missing"));
      },
    };
    const launchOutcome = await createMergePrExecutor({
      runner: throwingRunner,
    }).execute(ctx({ targetBranch: "main", sourceBranch: "feature-x" }));
    expect(launchOutcome).toMatchObject({
      status: "failed",
      failureClass: "transient_infra",
    });
  });
});

describe("createBeadsUpdateExecutor", () => {
  test("runs bd update and succeeds", async () => {
    const { runner, calls } = fakeRunner([]);
    const executor = createBeadsUpdateExecutor({ runner });
    const outcome = await executor.execute(
      ctx({ beadId: "MC-1", status: "closed" }),
    );
    expect(outcome).toEqual({
      status: "succeeded",
      output: { beadId: "MC-1", status: "closed" },
    });
    expect(calls[0]?.args).toEqual(["update", "MC-1", "--status", "closed"]);
  });

  test("a bd failure is retryable transient_infra", async () => {
    const { runner } = fakeRunner([
      {
        match: "update",
        result: { exitCode: 1, stdout: "", stderr: "bd error" },
      },
    ]);
    const executor = createBeadsUpdateExecutor({ runner });
    const outcome = await executor.execute(ctx({ beadId: "MC-1" }));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failureClass).toBe("transient_infra");
    }
  });

  test("rejects a config without a bead id", () => {
    expect(() => parseBeadsUpdateConfig({})).toThrow("config.beadId");
  });

  test("defaults status to closed and validates optional fields", () => {
    expect(parseBeadsUpdateConfig({ beadId: "MC-2" })).toEqual({
      beadId: "MC-2",
      status: "closed",
    });
    expect(() =>
      parseBeadsUpdateConfig({ beadId: "MC-2", beadsRepo: "" }),
    ).toThrow("config.beadsRepo");
    expect(() =>
      parseBeadsUpdateConfig({ beadId: "MC-2", status: false }),
    ).toThrow("config.status");
  });

  test("uses the configured executable and per-node Beads directory", async () => {
    const { runner, calls } = fakeRunner([]);
    const executor = createBeadsUpdateExecutor({
      runner,
      bd: "custom-bd",
      cwd: "/fallback",
    });
    await executor.execute(
      ctx({ beadId: "MC-3", beadsRepo: "/beads", status: "in_progress" }),
    );
    expect(calls[0]).toMatchObject({
      command: "custom-bd",
      options: { cwd: "/beads" },
    });
  });

  test("turns a bd launch failure into retryable data", async () => {
    const runner: CommandRunner = {
      run() {
        return Promise.reject(new Error("bd unavailable"));
      },
    };
    const outcome = await createBeadsUpdateExecutor({ runner }).execute(
      ctx({ beadId: "MC-4" }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      failureClass: "transient_infra",
    });
  });
});
