import type { CommandRunner } from "./command-runner.js";
import { createExecFileRunner } from "./command-runner.js";
import type { ReconciledPullRequest } from "./reconcile.js";

/**
 * Deterministic merge for a `merge_resolve` node whose pull request GitHub
 * already reports as cleanly mergeable. Most merges need no conflict
 * resolution, and an agent session that only calls `gh pr merge` costs a
 * cold start while holding the integration-branch lock. Anything other than
 * a clean merge is left to the agent, so the fast path never decides a
 * conflict or skips the validation that conflict resolution requires.
 */

export interface DirectMergeInput {
  readonly pullRequest: ReconciledPullRequest;
  readonly mergeMethod: "squash" | "merge" | "rebase";
  /** Git worktree `gh` executes in. */
  readonly worktreeDir: string;
  readonly signal?: AbortSignal;
}

export type DirectMergeResult =
  | { readonly merged: true }
  | { readonly merged: false; readonly reason: string };

export interface DirectMerger {
  merge(input: DirectMergeInput): Promise<DirectMergeResult>;
}

export interface GitHubDirectMergerOptions {
  readonly runner?: CommandRunner;
  /** `gh` executable. Default "gh". */
  readonly gh?: string;
}

/**
 * Merge states that need no agent: CLEAN (mergeable, checks passing) and
 * HAS_HOOKS (the same, on a GitHub Enterprise host with pre-receive hooks).
 * BEHIND and DIRTY need a rebase; BLOCKED, UNSTABLE, DRAFT, and UNKNOWN need
 * judgment or more time, which is the agent's job.
 */
const DIRECTLY_MERGEABLE_STATES: ReadonlySet<string> = new Set([
  "CLEAN",
  "HAS_HOOKS",
]);

export function isDirectlyMergeable(
  pullRequest: ReconciledPullRequest,
): boolean {
  return (
    pullRequest.state === "open" &&
    pullRequest.mergeStateStatus !== undefined &&
    DIRECTLY_MERGEABLE_STATES.has(pullRequest.mergeStateStatus)
  );
}

/**
 * Merge through `gh pr merge`. The known head is pinned with
 * --match-head-commit so a push after reconciliation cannot be merged
 * unseen. Failures are results, not errors: the caller falls back to the
 * agent session.
 */
export function createGitHubDirectMerger(
  options: GitHubDirectMergerOptions = {},
): DirectMerger {
  const runner = options.runner ?? createExecFileRunner();
  const gh = options.gh ?? "gh";

  return Object.freeze({
    async merge(input: DirectMergeInput): Promise<DirectMergeResult> {
      const args = [
        "pr",
        "merge",
        String(input.pullRequest.number),
        `--${input.mergeMethod}`,
        ...(input.pullRequest.headSha === undefined
          ? []
          : ["--match-head-commit", input.pullRequest.headSha]),
      ];
      let result;
      try {
        result = await runner.run(gh, args, {
          cwd: input.worktreeDir,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error: unknown) {
        if (input.signal?.aborted === true) {
          throw error;
        }
        return {
          merged: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim().split("\n")[0];
        return {
          merged: false,
          reason: `gh pr merge exited ${String(result.exitCode)}${detail === undefined || detail.length === 0 ? "" : `: ${detail}`}`,
        };
      }
      return { merged: true };
    },
  });
}
