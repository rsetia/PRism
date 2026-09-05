import { describe, expect, test } from "vitest";
import { parseProofOfWork } from "../src/index.js";
import type { JsonValue } from "../src/index.js";
import {
  createGitHubReconciler,
  describeReconciledState,
  sourceBranchFromInput,
} from "../src/node/index.js";
import type {
  CommandResult,
  CommandRunner,
  ReconcileOutcome,
  RunCommandOptions,
  WorkerSpec,
} from "../src/node/index.js";

interface Recorded {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: RunCommandOptions;
}

interface Stub {
  readonly match: string;
  readonly result: Partial<CommandResult>;
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
      const line = `${command} ${args.join(" ")}`;
      const stub = stubs.find((s) => line.includes(s.match));
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        ...stub?.result,
      });
    },
  };
  return { runner, calls };
}

function implementSpec(
  overrides: Partial<WorkerSpec> = {},
  review: JsonValue = { by: "claude" },
): WorkerSpec {
  return {
    runId: "run-1",
    nodeId: "implement-x",
    kind: "task",
    executor: "implement",
    input: null,
    config: {
      workItem: { provider: "beads", id: "X-1" },
      targetBranch: "prism/integration",
      branchName: "prism/x-1",
      review,
    },
    attempt: 1,
    ...overrides,
  };
}

const lsRemoteHit = {
  match: "ls-remote",
  result: { stdout: "abc123\trefs/heads/prism/x-1\n" },
};

function prList(entries: readonly Record<string, unknown>[]): Stub {
  return { match: "pr list", result: { stdout: JSON.stringify(entries) } };
}

function prView(detail: Record<string, unknown>): Stub {
  return { match: "pr view", result: { stdout: JSON.stringify(detail) } };
}

const openPr = {
  number: 5,
  url: "https://github.com/o/r/pull/5",
  state: "OPEN",
  headRefOid: "abc123",
  mergeStateStatus: "CLEAN",
};

const headCommit = { oid: "abc123", committedDate: "2026-09-05T23:20:12Z" };
const greenChecks = [
  { name: "verify", status: "COMPLETED", conclusion: "SUCCESS" },
];

async function reconcile(
  stubs: readonly Stub[],
  spec: WorkerSpec,
): Promise<{ outcome: ReconcileOutcome; calls: Recorded[] }> {
  const { runner, calls } = fakeRunner(stubs);
  const reconciler = createGitHubReconciler({ runner });
  const outcome = await reconciler.reconcile({
    spec,
    worktreeDir: "/tmp/worktree",
  });
  return { outcome, calls };
}

describe("createGitHubReconciler for implement nodes", () => {
  test("starts fresh when the branch is not on the remote", async () => {
    const { outcome, calls } = await reconcile(
      [{ match: "ls-remote", result: { stdout: "" } }, prList([])],
      implementSpec(),
    );
    expect(outcome.kind).toBe("fresh");
    expect(calls.map((c) => c.command)).toEqual(["git", "gh"]);
    expect(calls[0]?.options?.cwd).toBe("/tmp/worktree");
    expect(calls.every((c) => !c.args.includes("merge"))).toBe(true);
  });

  test("starts fresh when the node has no fixed branch name", async () => {
    const spec = implementSpec({
      config: {
        workItem: { provider: "beads", id: "X-1" },
        targetBranch: "main",
        review: { by: "claude" },
      },
    });
    const { outcome, calls } = await reconcile([lsRemoteHit], spec);
    expect(outcome.kind).toBe("fresh");
    expect(calls).toHaveLength(0);
  });

  test("resumes with in-progress review when Claude is still working", async () => {
    const { outcome } = await reconcile(
      [
        lsRemoteHit,
        prList([openPr]),
        prView({
          headRefOid: "abc123",
          statusCheckRollup: greenChecks,
          reviews: [],
          commits: [headCommit],
          comments: [
            {
              author: { login: "rsetia" },
              body: "@claude review",
              createdAt: "2026-09-05T23:20:34Z",
            },
            {
              author: { login: "claude" },
              body: "### Reviewing PR #5\n\n- [x] Gather context\n- [ ] Review files",
              createdAt: "2026-09-05T23:20:50Z",
              url: "https://github.com/o/r/pull/5#issuecomment-1",
            },
          ],
        }),
      ],
      implementSpec(),
    );
    expect(outcome.kind).toBe("resume");
    if (outcome.kind !== "resume") return;
    expect(outcome.state.ci).toBe("passed");
    expect(outcome.state.pullRequest?.number).toBe(5);
    expect(outcome.state.review).toMatchObject({
      reviewer: "claude",
      verdict: "pending",
      inProgress: true,
    });
    const text = describeReconciledState(outcome.state);
    expect(text).toContain('"inProgress": true');
    expect(text).toContain("do not fail the node as timed out");
  });

  test("resumes with changes_requested when the finished review lists findings", async () => {
    const { outcome } = await reconcile(
      [
        lsRemoteHit,
        prList([openPr]),
        prView({
          headRefOid: "abc123",
          statusCheckRollup: greenChecks,
          reviews: [],
          commits: [headCommit],
          comments: [
            {
              author: { login: "claude" },
              body: "**Claude finished @rsetia's task**\n\n### Summary\nSolid work. I found one correctness bug.\n\n### Findings\n\n**1. `claim()` can raise** ...",
              createdAt: "2026-09-05T23:24:30Z",
            },
          ],
        }),
      ],
      implementSpec(),
    );
    expect(outcome.kind).toBe("resume");
    if (outcome.kind !== "resume") return;
    expect(outcome.state.review).toMatchObject({
      verdict: "changes_requested",
      inProgress: false,
    });
    expect(outcome.state.review?.excerpt).toContain("correctness bug");
  });

  test("is satisfied without an agent when the head is approved and green", async () => {
    const { outcome } = await reconcile(
      [
        lsRemoteHit,
        prList([openPr]),
        prView({
          headRefOid: "abc123",
          statusCheckRollup: greenChecks,
          reviews: [],
          commits: [headCommit],
          comments: [
            {
              author: { login: "claude" },
              body: "**Claude finished the task**\n\nThe changes look good and are ready to merge. No remaining actionable findings.",
              createdAt: "2026-09-05T23:24:30Z",
              url: "https://github.com/o/r/pull/5#issuecomment-2",
            },
          ],
        }),
      ],
      implementSpec(),
    );
    expect(outcome.kind).toBe("satisfied");
    if (outcome.kind !== "satisfied") return;
    const proof = parseProofOfWork(outcome.output);
    expect(proof.pullRequests[0]).toMatchObject({
      number: 5,
      branch: "prism/x-1",
      headSha: "abc123",
    });
    expect(proof.reviewVerdicts[0]).toMatchObject({
      reviewer: "claude",
      verdict: "approved",
      headSha: "abc123",
    });
    expect(proof.commits).toEqual([{ sha: "abc123" }]);
  });

  test("ignores reviewer responses that predate the current head", async () => {
    const { outcome } = await reconcile(
      [
        lsRemoteHit,
        prList([openPr]),
        prView({
          headRefOid: "abc123",
          statusCheckRollup: greenChecks,
          reviews: [],
          commits: [{ oid: "abc123", committedDate: "2026-09-05T23:30:00Z" }],
          comments: [
            {
              author: { login: "claude" },
              body: "Looks good, ready to merge.",
              createdAt: "2026-09-05T23:24:30Z",
            },
          ],
        }),
      ],
      implementSpec(),
    );
    expect(outcome.kind).toBe("resume");
    if (outcome.kind !== "resume") return;
    expect(outcome.state.review).toMatchObject({
      verdict: "pending",
      inProgress: false,
    });
  });

  test("keeps waiting for checks when the review is positive but CI is pending", async () => {
    const { outcome } = await reconcile(
      [
        lsRemoteHit,
        prList([openPr]),
        prView({
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "verify", status: "IN_PROGRESS" }],
          reviews: [
            {
              author: { login: "claude" },
              state: "APPROVED",
              body: "",
              submittedAt: "2026-09-05T23:24:30Z",
            },
          ],
          commits: [headCommit],
          comments: [],
        }),
      ],
      implementSpec(),
    );
    expect(outcome.kind).toBe("resume");
    if (outcome.kind !== "resume") return;
    expect(outcome.state.ci).toBe("pending");
    expect(outcome.state.review?.verdict).toBe("approved");
  });

  test("is satisfied when the pull request already merged", async () => {
    const { outcome, calls } = await reconcile(
      [
        lsRemoteHit,
        prList([
          {
            number: 5,
            url: "https://github.com/o/r/pull/5",
            state: "MERGED",
            headRefOid: "abc123",
            mergeCommit: { oid: "merge789" },
          },
        ]),
      ],
      implementSpec(),
    );
    expect(outcome.kind).toBe("satisfied");
    if (outcome.kind !== "satisfied") return;
    const proof = parseProofOfWork(outcome.output);
    expect(proof.commits).toEqual([{ sha: "merge789" }]);
    expect(calls.some((c) => c.args.includes("view"))).toBe(false);
  });

  test("reads Greptile confidence scores against the configured minimum", async () => {
    const { outcome } = await reconcile(
      [
        lsRemoteHit,
        prList([openPr]),
        prView({
          headRefOid: "abc123",
          statusCheckRollup: greenChecks,
          reviews: [],
          commits: [headCommit],
          comments: [
            {
              author: { login: "greptile-apps" },
              body: "Confidence Score: 4/5\n\nOne small concern.",
              createdAt: "2026-09-05T23:24:30Z",
            },
          ],
        }),
      ],
      implementSpec({}, { by: "greptile", minConfidenceScore: 5 }),
    );
    expect(outcome.kind).toBe("resume");
    if (outcome.kind !== "resume") return;
    expect(outcome.state.review).toMatchObject({
      reviewer: "greptile",
      verdict: "changes_requested",
      confidenceScore: 4,
    });
  });

  test("degrades to fresh when gh is unavailable", async () => {
    const { runner } = fakeRunner([]);
    const failing: CommandRunner = {
      run(command, args, options) {
        if (command === "gh") {
          return Promise.reject(new Error("spawn gh ENOENT"));
        }
        return runner.run(command, args, options);
      },
    };
    const reconciler = createGitHubReconciler({ runner: failing });
    const outcome = await reconciler.reconcile({
      spec: implementSpec(),
      worktreeDir: "/tmp/worktree",
    });
    expect(outcome.kind).toBe("fresh");
    if (outcome.kind !== "fresh") return;
    expect(outcome.notes.join(" ")).toContain("ENOENT");
  });
});

describe("createGitHubReconciler for merge and finalize nodes", () => {
  const mergeSpec: WorkerSpec = {
    runId: "run-1",
    nodeId: "merge-x",
    kind: "merge",
    executor: "merge_resolve",
    input: {
      version: 1,
      summary: "implemented",
      commits: [{ sha: "abc123" }],
      pullRequests: [
        {
          url: "https://github.com/o/r/pull/5",
          number: 5,
          branch: "prism/x-1",
          headSha: "abc123",
        },
      ],
      validations: [],
      reviewVerdicts: [],
      screenshots: [],
      artifacts: [],
      unresolvedRisks: [],
    },
    config: {
      targetBranch: "prism/integration",
      sourceBranchFrom: "implement-x",
    },
    attempt: 2,
  };

  test("merge_resolve is satisfied when the upstream PR already merged", async () => {
    const { outcome } = await reconcile(
      [
        lsRemoteHit,
        prList([
          {
            number: 5,
            url: "https://github.com/o/r/pull/5",
            state: "MERGED",
            headRefOid: "abc123",
            mergeCommit: { oid: "merge789" },
          },
        ]),
      ],
      mergeSpec,
    );
    expect(outcome.kind).toBe("satisfied");
    if (outcome.kind !== "satisfied") return;
    expect(parseProofOfWork(outcome.output).summary).toContain(
      "already merged",
    );
  });

  test("merge_resolve resumes with merge state when the PR is still open", async () => {
    const { outcome } = await reconcile(
      [lsRemoteHit, prList([{ ...openPr, mergeStateStatus: "DIRTY" }])],
      mergeSpec,
    );
    expect(outcome.kind).toBe("resume");
    if (outcome.kind !== "resume") return;
    expect(outcome.state.pullRequest?.mergeStateStatus).toBe("DIRTY");
  });

  test("finalize_pr is satisfied when the integration PR is approved and green", async () => {
    const spec: WorkerSpec = {
      runId: "run-1",
      nodeId: "finalize",
      kind: "task",
      executor: "finalize_pr",
      input: null,
      config: {
        sourceBranch: "prism/integration",
        targetBranch: "main",
        review: { by: "claude" },
      },
      attempt: 1,
    };
    const { outcome } = await reconcile(
      [
        {
          match: "ls-remote",
          result: { stdout: "def456\trefs/heads/prism/integration\n" },
        },
        prList([{ ...openPr, number: 9, headRefOid: "def456" }]),
        prView({
          headRefOid: "def456",
          statusCheckRollup: greenChecks,
          reviews: [
            {
              author: { login: "claude" },
              state: "APPROVED",
              body: "",
              submittedAt: "2026-09-05T23:24:30Z",
            },
          ],
          commits: [{ oid: "def456", committedDate: "2026-09-05T23:20:12Z" }],
          comments: [],
        }),
      ],
      spec,
    );
    expect(outcome.kind).toBe("satisfied");
  });
});

describe("sourceBranchFromInput", () => {
  test("reads proof-of-work, legacy metadata, and plain strings", () => {
    expect(
      sourceBranchFromInput({
        version: 1,
        summary: "s",
        commits: [],
        pullRequests: [{ url: "https://x/pr/1", branch: "prism/a" }],
        validations: [],
        reviewVerdicts: [],
        screenshots: [],
        artifacts: [],
        unresolvedRisks: [],
      }),
    ).toBe("prism/a");
    expect(sourceBranchFromInput({ metadata: { branch: "prism/b" } })).toBe(
      "prism/b",
    );
    expect(sourceBranchFromInput(["prism/c"])).toBe("prism/c");
    expect(sourceBranchFromInput(null)).toBeUndefined();
  });
});
