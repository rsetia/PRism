import { describe, expect, test } from "vitest";
import {
  buildFinalizePrContract,
  buildImplementContract,
  buildMergeResolveContract,
  codexContractForSpec,
  parseFinalizePrConfig,
  parseImplementConfig,
  parseMergeResolveConfig,
} from "../src/node/index.js";
import type { ImplementConfig, WorkerSpec } from "../src/node/index.js";
import type { JsonValue } from "../src/index.js";

const implementConfig = (
  overrides: Record<string, JsonValue> = {},
): JsonValue => ({
  workItem: { provider: "beads", id: "MC-1", url: "beads://MC-1" },
  targetBranch: "main",
  review: { by: "greptile" },
  ...overrides,
});

const spec = (overrides: Partial<WorkerSpec> = {}): WorkerSpec => ({
  runId: "r",
  nodeId: "n",
  kind: "task",
  executor: "implement",
  input: null,
  config: implementConfig(),
  attempt: 1,
  ...overrides,
});

describe("parseImplementConfig", () => {
  test("extracts a valid config", () => {
    const parsed = parseImplementConfig(
      implementConfig({
        branchName: "prism/mc-1",
        maxIterations: 4,
        validationCommands: ["npm test", "npm run lint"],
        review: {
          by: "greptile",
          greptileAppSlug: " greptile-apps ",
          minConfidenceScore: 5,
          requireApproved: false,
          requireNoActionableFindings: true,
          requireGreenChecks: true,
          allowConfidenceFourWithoutActionableFindings: true,
          triggerComment: "@greptileai review",
        },
      }),
    );
    expect(parsed.workItem.id).toBe("MC-1");
    expect(parsed.targetBranch).toBe("main");
    expect(parsed.review.by).toBe("greptile");
    expect(parsed.branchName).toBe("prism/mc-1");
    expect(parsed.maxIterations).toBe(4);
    expect(parsed.validationCommands).toEqual(["npm test", "npm run lint"]);
    expect(parsed.review).toMatchObject({
      greptileAppSlug: "greptile-apps",
      minConfidenceScore: 5,
      requireApproved: false,
      requireNoActionableFindings: true,
      requireGreenChecks: true,
      allowConfidenceFourWithoutActionableFindings: true,
      triggerComment: "@greptileai review",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.workItem)).toBe(true);
    expect(Object.isFrozen(parsed.review)).toBe(true);
    expect(Object.isFrozen(parsed.validationCommands)).toBe(true);
  });

  test("applies work-item and target defaults", () => {
    expect(
      parseImplementConfig({
        workItem: { id: "MC-2" },
        review: { by: "none" },
      }),
    ).toMatchObject({
      workItem: { provider: "beads", id: "MC-2" },
      targetBranch: "main",
      review: { by: "none" },
    });
  });

  test("rejects a missing work item id", () => {
    expect(() =>
      parseImplementConfig(implementConfig({ workItem: {} })),
    ).toThrow("config.workItem.id");
  });

  test("rejects an unknown review gate", () => {
    expect(() =>
      parseImplementConfig(implementConfig({ review: { by: "robots" } })),
    ).toThrow("config.review.by");
  });

  test("rejects a non-object config", () => {
    expect(() => parseImplementConfig(null)).toThrow("config");
  });

  test.each([
    ["branchName", { branchName: "" }, "config.branchName"],
    ["maxIterations", { maxIterations: 0 }, "config.maxIterations"],
    [
      "validationCommands",
      { validationCommands: ["npm test", 4] },
      "config.validationCommands[1]",
    ],
    [
      "greptileAppSlug",
      { review: { by: "greptile", greptileAppSlug: "" } },
      "config.review.greptileAppSlug",
    ],
    [
      "minConfidenceScore",
      { review: { by: "greptile", minConfidenceScore: 6 } },
      "config.review.minConfidenceScore",
    ],
    [
      "requireGreenChecks",
      { review: { by: "greptile", requireGreenChecks: "yes" } },
      "config.review.requireGreenChecks",
    ],
    [
      "triggerComment",
      { review: { by: "claude", triggerComment: "" } },
      "config.review.triggerComment",
    ],
  ])("rejects an invalid %s field", (_field, override, errorField) => {
    expect(() =>
      parseImplementConfig(
        implementConfig(override as Record<string, JsonValue>),
      ),
    ).toThrow(errorField);
  });

  test("rejects a Greptile app slug for another review gate", () => {
    expect(() =>
      parseImplementConfig(
        implementConfig({
          review: { by: "claude", greptileAppSlug: "greptile-apps" },
        }),
      ),
    ).toThrow('requires config.review.by to be "greptile"');
  });
});

describe("buildImplementContract", () => {
  const base: ImplementConfig = {
    workItem: { provider: "beads", id: "MC-1" },
    targetBranch: "main",
    review: { by: "greptile" },
  };

  test("grants git and GitHub permissions", () => {
    const contract = buildImplementContract(base);
    expect(contract.allowsGitMutation).toBe(true);
    expect(contract.allowsGitHubIo).toBe(true);
    expect(contract.dangerouslyBypassApprovalsAndSandbox).toBe(true);
    expect(contract.requiredExecutionMode).toBe("trusted-local");
    expect(contract.sandbox).toBeUndefined();
    expect(contract.instructions.length).toBeGreaterThan(0);
    expect(contract.instructions).toContain('"status":"succeeded"');
    expect(contract.instructions).toContain('"metadata"');
    expect(contract.instructions).toContain('"branch"');
    expect(contract.instructions).toContain(
      "start the iteration count at zero",
    );
    expect(contract.instructions).toContain(
      "never count historical commits, comments, review cycles",
    );
  });

  test("reflects the greptile review gate in the instructions", () => {
    const contract = buildImplementContract({
      ...base,
      maxIterations: 3,
      validationCommands: ["npm run verify"],
      review: {
        by: "greptile",
        minConfidenceScore: 4,
        allowConfidenceFourWithoutActionableFindings: true,
      },
    });
    expect(contract.instructions).toContain("Greptile");
    expect(contract.instructions).toContain("@greptile review");
    expect(contract.instructions).toContain("Confidence Score: N/5");
    expect(contract.instructions).toContain("at least 4");
    expect(contract.instructions).toContain("npm run verify");
    expect(contract.instructions).toContain("at most 3");
    expect(contract.extraRules?.join("\n")).toContain("current-head");
  });

  test("defaults the greptile gate to a current-head 5/5", () => {
    const contract = buildImplementContract(base);
    expect(contract.instructions).toContain("at least 5/5");
    expect(contract.instructions).toContain(
      "never reuse a score from an older head",
    );
    expect(contract.instructions).toContain(
      "Do not accept a Greptile confidence score below",
    );
    expect(contract.instructions).not.toContain("greptile-apps[bot]");
  });

  test("filters Greptile feedback to the configured GitHub App", () => {
    const contract = buildImplementContract({
      ...base,
      review: { by: "greptile", greptileAppSlug: "greptile-apps" },
    });
    expect(contract.instructions).toContain(
      'check_run.app.slug === "greptile-apps"',
    );
    expect(contract.instructions).toContain('"greptile-apps[bot]"');
    expect(contract.instructions).toContain(
      "Apply that app-identity filter before making code changes",
    );
    expect(contract.instructions).toContain(
      "if it responds first, keep waiting",
    );
    expect(contract.extraRules?.join("\n")).toContain(
      "discard all other app feedback before any action or gate decision",
    );
  });

  test("reflects the claude review gate in the instructions", () => {
    const contract = buildImplementContract({
      ...base,
      review: {
        by: "claude",
        triggerComment: "@claude inspect",
        requireApproved: true,
      },
    });
    expect(contract.instructions).toContain("Claude");
    expect(contract.instructions).toContain("@claude inspect");
    expect(contract.instructions).toContain("CHANGES_REQUESTED");
    expect(contract.instructions).toContain(
      "latest substantive Claude-authored current-head response",
    );
    expect(contract.instructions).toContain("look good");
    expect(contract.instructions).toContain("ready or good to merge");
    expect(contract.instructions).toContain("no remaining actionable findings");
    expect(contract.instructions).toContain(
      "does not require a formal GitHub review object",
    );
    expect(contract.instructions).toContain(
      "mixed response containing findings is not ready",
    );
  });

  test("uses only CI as the none review gate", () => {
    const contract = buildImplementContract({
      ...base,
      review: { by: "none" },
    });
    expect(contract.instructions).toContain(
      "Gate only on validation and CI/check results",
    );
  });
});

describe("parseMergeResolveConfig", () => {
  test("extracts a valid config", () => {
    const parsed = parseMergeResolveConfig({
      targetBranch: "main",
      sourceBranchFrom: "implement-mc-1",
    });
    expect(parsed.targetBranch).toBe("main");
    expect(parsed.sourceBranchFrom).toBe("implement-mc-1");
    expect(parsed.mergeMethod).toBe("squash");
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test("rejects a missing sourceBranchFrom", () => {
    expect(() => parseMergeResolveConfig({ targetBranch: "main" })).toThrow(
      "config.sourceBranchFrom",
    );
  });

  test("validates the merge method and commands", () => {
    expect(() =>
      parseMergeResolveConfig({
        targetBranch: "main",
        sourceBranchFrom: "implement-mc-1",
        mergeMethod: "octopus",
      }),
    ).toThrow("config.mergeMethod");
    expect(() =>
      parseMergeResolveConfig({
        targetBranch: "main",
        sourceBranchFrom: "implement-mc-1",
        validationCommands: [false],
      }),
    ).toThrow("config.validationCommands[0]");
  });
});

describe("buildMergeResolveContract", () => {
  test("grants git and GitHub permissions", () => {
    const contract = buildMergeResolveContract({
      targetBranch: "main",
      sourceBranchFrom: "implement-mc-1",
    });
    expect(contract.allowsGitMutation).toBe(true);
    expect(contract.allowsGitHubIo).toBe(true);
    expect(contract.dangerouslyBypassApprovalsAndSandbox).toBe(true);
    expect(contract.requiredExecutionMode).toBe("trusted-local");
    expect(contract.sandbox).toBeUndefined();
    expect(contract.instructions).toContain("implement-mc-1");
    expect(contract.instructions).toContain("--force-with-lease");
    expect(contract.instructions).toContain("Never direct-push");
    expect(contract.instructions).toContain('"merge_commit"');
  });

  test("includes the configured merge method and validation commands", () => {
    const contract = buildMergeResolveContract({
      targetBranch: "develop",
      sourceBranchFrom: "implement-mc-2",
      mergeMethod: "rebase",
      validationCommands: ["npm test"],
    });
    expect(contract.instructions).toContain("rebase method");
    expect(contract.instructions).toContain("npm test");
    expect(contract.instructions).toContain("origin/develop");
  });
});

describe("finalize_pr contract", () => {
  test("parses a reviewed integration PR configuration", () => {
    const parsed = parseFinalizePrConfig({
      sourceBranch: "prism/integration",
      targetBranch: "main",
      review: {
        by: "claude",
        triggerComment: "@claude review",
        requireGreenChecks: true,
      },
      draft: false,
      maxIterations: 4,
      validationCommands: ["npm run verify"],
    });
    expect(parsed).toMatchObject({
      sourceBranch: "prism/integration",
      targetBranch: "main",
      review: { by: "claude", triggerComment: "@claude review" },
      draft: false,
      maxIterations: 4,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test("rejects identical source and target branches", () => {
    expect(() =>
      parseFinalizePrConfig({
        sourceBranch: "main",
        targetBranch: "main",
        review: { by: "none" },
      }),
    ).toThrow("must differ");
  });

  test("leaves the reviewed pull request open for a human merge", () => {
    const contract = buildFinalizePrContract({
      sourceBranch: "prism/integration",
      targetBranch: "main",
      review: { by: "claude", requireGreenChecks: true },
      validationCommands: ["npm run verify"],
    });
    expect(contract.instructions).toContain("@claude review");
    expect(contract.instructions).toContain("npm run verify");
    expect(contract.instructions).toContain("Never merge or close");
    expect(contract.instructions).toContain("ready_for_human_merge");
    expect(contract.allowsGitMutation).toBe(true);
    expect(contract.allowsGitHubIo).toBe(true);
  });
});

describe("codexContractForSpec", () => {
  test("dispatches implement specs to the implement contract", () => {
    const contract = codexContractForSpec(spec());
    expect(contract.allowsGitHubIo).toBe(true);
    expect(contract.instructions.toLowerCase()).toContain("greptile");
  });

  test("dispatches merge_resolve specs", () => {
    const contract = codexContractForSpec(
      spec({
        executor: "merge_resolve",
        config: {
          targetBranch: "main",
          sourceBranchFrom: "implement-mc-1",
        },
      }),
    );
    expect(contract.allowsGitMutation).toBe(true);
  });

  test("dispatches finalize_pr specs", () => {
    const contract = codexContractForSpec(
      spec({
        executor: "finalize_pr",
        config: {
          sourceBranch: "prism/integration",
          targetBranch: "main",
          review: { by: "claude" },
        },
      }),
    );
    expect(contract.instructions).toContain("without merging it");
  });

  test("rejects a non-codex executor", () => {
    expect(() => codexContractForSpec(spec({ executor: "constant" }))).toThrow(
      "constant",
    );
  });
});
