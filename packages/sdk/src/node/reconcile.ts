import type { JsonValue } from "../graph/types.js";
import { isPlainObject } from "../internal/json.js";
import {
  PROOF_OF_WORK_VERSION,
  tryParseProofOfWork,
  type ProofOfWorkV1,
  type ReviewVerdictEvidence,
} from "../runtime/proof-of-work.js";
import type { CommandRunner } from "./command-runner.js";
import { createExecFileRunner } from "./command-runner.js";
import {
  parseFinalizePrConfig,
  parseImplementConfig,
  parseMergeResolveConfig,
  type ReviewConfig,
} from "./codex-contracts.js";
import type { WorkerSpec } from "./worker-protocol.js";

/**
 * Node reconciliation: before an agent session starts (first attempt,
 * retry, resume, or administrative reset), inspect the external state the
 * node is responsible for and decide what is left to do. Each executor kind
 * has its own procedure because each leaves different evidence behind:
 *
 * - `implement`: a feature branch, a pull request, CI on its head, and a
 *   reviewer verdict for that head.
 * - `merge_resolve`: whether the upstream pull request already merged.
 * - `finalize_pr`: the integration pull request and its review.
 *
 * The outcome is data. `satisfied` means the node's proof-of-work can be
 * reconstructed from the source system without spending an agent session.
 * `resume` hands the agent a factual summary so it continues from the real
 * state instead of re-deriving it from a prompt. `fresh` means nothing is
 * known, or reconciliation could not run; the agent starts as before.
 *
 * Reconciliation never blocks a node: every failure to inspect degrades to
 * `fresh` with a note, because the agent can still discover the state
 * itself. It never mutates git or GitHub.
 */

export interface ReconcileInput {
  readonly spec: WorkerSpec;
  /** Git worktree the agent will run in; `gh` and `git` execute here. */
  readonly worktreeDir: string;
  readonly signal?: AbortSignal;
}

export type CiState = "passed" | "failed" | "pending" | "none";

export interface ReconciledReview {
  readonly reviewer: string;
  readonly verdict: ReviewVerdictEvidence["verdict"];
  /** True when the reviewer has acknowledged the head but not finished. */
  readonly inProgress: boolean;
  readonly url?: string;
  /** Bounded excerpt of the latest reviewer response for the current head. */
  readonly excerpt?: string;
  /** Greptile confidence score when one was reported for this head. */
  readonly confidenceScore?: number;
}

export interface ReconciledPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "merged" | "closed";
  readonly headSha?: string;
  readonly headCommittedAt?: string;
  readonly mergeStateStatus?: string;
}

/** The factual state handed to an agent that must continue prior work. */
export interface ReconciledState {
  readonly executor: string;
  readonly branch: string;
  readonly branchExists: boolean;
  readonly pullRequest?: ReconciledPullRequest;
  readonly ci: CiState;
  readonly review?: ReconciledReview;
  /** Trigger comments posted on the pull request so far, by any author. */
  readonly reviewRequests?: number;
  readonly notes: readonly string[];
}

export type ReconcileOutcome =
  | { readonly kind: "fresh"; readonly notes: readonly string[] }
  | { readonly kind: "resume"; readonly state: ReconciledState }
  | {
      readonly kind: "satisfied";
      readonly state: ReconciledState;
      /** Proof-of-work reconstructed from the source system. */
      readonly output: JsonValue;
    };

export interface NodeReconciler {
  reconcile(input: ReconcileInput): Promise<ReconcileOutcome>;
}

export interface GitHubReconcilerOptions {
  readonly runner?: CommandRunner;
  /** `gh` executable. Default "gh". */
  readonly gh?: string;
  /** `git` executable. Default "git". */
  readonly git?: string;
  /** Remote the feature branches are pushed to. Default "origin". */
  readonly remote?: string;
}

const EXCERPT_LIMIT = 1_500;

/**
 * Reconcile Codex executor nodes against git and GitHub through the `gh`
 * CLI. Only reads are issued: `git ls-remote`, `gh pr list`, `gh pr view`.
 */
export function createGitHubReconciler(
  options: GitHubReconcilerOptions = {},
): NodeReconciler {
  const runner = options.runner ?? createExecFileRunner();
  const gh = nonEmpty(options.gh, "gh") ?? "gh";
  const git = nonEmpty(options.git, "git") ?? "git";
  const remote = nonEmpty(options.remote, "remote") ?? "origin";
  const tools: Tools = { runner, gh, git, remote };

  return Object.freeze({
    async reconcile(input: ReconcileInput): Promise<ReconcileOutcome> {
      try {
        switch (input.spec.executor) {
          case "implement":
            return await reconcileImplement(tools, input);
          case "merge_resolve":
            return await reconcileMergeResolve(tools, input);
          case "finalize_pr":
            return await reconcileFinalizePr(tools, input);
          default:
            return fresh([
              `no reconciliation procedure for executor "${input.spec.executor}"`,
            ]);
        }
      } catch (error: unknown) {
        if (input.signal?.aborted === true) {
          throw error;
        }
        return fresh([`reconciliation skipped: ${describe(error)}`]);
      }
    },
  });
}

/**
 * Render a reconciled state as instructions appended to an agent contract.
 * Kept here so the wording lives next to the data it describes.
 */
export function describeReconciledState(state: ReconciledState): string {
  return `Current state, reconciled by the orchestrator immediately before this session (JSON):
${JSON.stringify(state, null, 2)}

Resume from that state rather than re-deriving it:
- The branch and pull request above already exist; reuse them. Never create a duplicate branch or pull request.
- If pullRequest.state is "open" and review.verdict is "changes_requested", read the full reviewer response on the pull request, fix every current-head actionable finding, rerun validation, push, and re-request review. That is one iteration.
- If review.inProgress is true, the reviewer is still working on the current head: poll and wait for it; do not post the trigger again and do not fail the node as timed out.
- If ci is "failed", fix the failing checks before anything else.
- If ci is "pending", wait for the checks on the current head.
- Start the iteration count at zero; prior attempts do not count against this session.`;
}

interface Tools {
  readonly runner: CommandRunner;
  readonly gh: string;
  readonly git: string;
  readonly remote: string;
}

async function reconcileImplement(
  tools: Tools,
  input: ReconcileInput,
): Promise<ReconcileOutcome> {
  const config = parseImplementConfig(input.spec.config ?? undefined);
  if (config.branchName === undefined) {
    return fresh(["implement node has no fixed branchName to reconcile"]);
  }
  return reconcileReviewedBranch(tools, input, {
    branch: config.branchName,
    targetBranch: config.targetBranch,
    review: config.review,
    requireGreenChecks: config.review.requireGreenChecks ?? true,
  });
}

async function reconcileFinalizePr(
  tools: Tools,
  input: ReconcileInput,
): Promise<ReconcileOutcome> {
  const config = parseFinalizePrConfig(input.spec.config ?? undefined);
  return reconcileReviewedBranch(tools, input, {
    branch: config.sourceBranch,
    targetBranch: config.targetBranch,
    review: config.review,
    requireGreenChecks: config.review.requireGreenChecks ?? true,
  });
}

async function reconcileMergeResolve(
  tools: Tools,
  input: ReconcileInput,
): Promise<ReconcileOutcome> {
  const config = parseMergeResolveConfig(input.spec.config ?? undefined);
  const branch = sourceBranchFromInput(input.spec.input);
  if (branch === undefined) {
    return fresh(["merge_resolve input names no upstream branch"]);
  }
  const notes: string[] = [];
  const branchExists = await remoteBranchExists(tools, input, branch, notes);
  const pullRequest = await lookupPullRequest(
    tools,
    input,
    branch,
    config.targetBranch,
    notes,
  );
  const base: ReconciledState = {
    executor: input.spec.executor,
    branch,
    branchExists,
    ...(pullRequest === undefined ? {} : { pullRequest: pullRequest.summary }),
    ci: "none",
    notes,
  };
  if (pullRequest === undefined) {
    return branchExists
      ? { kind: "resume", state: base }
      : fresh([...notes, `branch "${branch}" is not on the remote`]);
  }
  if (pullRequest.summary.state === "merged") {
    return {
      kind: "satisfied",
      state: base,
      output: proofFor({
        summary: `Reconciled: pull request #${String(pullRequest.summary.number)} from ${branch} is already merged into ${config.targetBranch}.`,
        branch,
        pullRequest: pullRequest.summary,
        commitSha: pullRequest.mergeCommitSha ?? pullRequest.summary.headSha,
      }),
    };
  }
  return { kind: "resume", state: base };
}

interface ReviewedBranchInput {
  readonly branch: string;
  readonly targetBranch: string;
  readonly review: ReviewConfig;
  readonly requireGreenChecks: boolean;
}

async function reconcileReviewedBranch(
  tools: Tools,
  input: ReconcileInput,
  reviewed: ReviewedBranchInput,
): Promise<ReconcileOutcome> {
  const notes: string[] = [];
  const branchExists = await remoteBranchExists(
    tools,
    input,
    reviewed.branch,
    notes,
  );
  const pullRequest = await lookupPullRequest(
    tools,
    input,
    reviewed.branch,
    reviewed.targetBranch,
    notes,
  );
  if (pullRequest === undefined) {
    if (!branchExists) {
      return fresh(notes);
    }
    return {
      kind: "resume",
      state: {
        executor: input.spec.executor,
        branch: reviewed.branch,
        branchExists,
        ci: "none",
        notes: [...notes, "branch exists but no pull request was found"],
      },
    };
  }

  if (pullRequest.summary.state === "merged") {
    const state: ReconciledState = {
      executor: input.spec.executor,
      branch: reviewed.branch,
      branchExists,
      pullRequest: pullRequest.summary,
      ci: "none",
      notes,
    };
    return {
      kind: "satisfied",
      state,
      output: proofFor({
        summary: `Reconciled: pull request #${String(pullRequest.summary.number)} from ${reviewed.branch} is already merged into ${reviewed.targetBranch}.`,
        branch: reviewed.branch,
        pullRequest: pullRequest.summary,
        commitSha: pullRequest.mergeCommitSha ?? pullRequest.summary.headSha,
        ...(reviewed.review.by === "none"
          ? {}
          : {
              review: {
                reviewer: reviewed.review.by,
                verdict: "approved",
                inProgress: false,
              },
            }),
      }),
    };
  }

  if (pullRequest.summary.state === "closed") {
    return {
      kind: "resume",
      state: {
        executor: input.spec.executor,
        branch: reviewed.branch,
        branchExists,
        pullRequest: pullRequest.summary,
        ci: "none",
        notes: [
          ...notes,
          "the pull request was closed without merging; reopen it or open a new one",
        ],
      },
    };
  }

  const detail = await viewPullRequest(
    tools,
    input,
    pullRequest.summary.number,
    notes,
  );
  const summary: ReconciledPullRequest = {
    ...pullRequest.summary,
    ...(detail?.headSha === undefined ? {} : { headSha: detail.headSha }),
    ...(detail?.headCommittedAt === undefined
      ? {}
      : { headCommittedAt: detail.headCommittedAt }),
  };
  const ci = detail?.ci ?? "none";
  const review =
    detail === undefined || reviewed.review.by === "none"
      ? undefined
      : classifyReview(reviewed.review, detail);
  const reviewRequests =
    detail === undefined || reviewed.review.by === "none"
      ? undefined
      : countReviewRequests(reviewed.review, detail);
  const state: ReconciledState = {
    executor: input.spec.executor,
    branch: reviewed.branch,
    branchExists,
    pullRequest: summary,
    ci,
    ...(review === undefined ? {} : { review }),
    ...(reviewRequests === undefined ? {} : { reviewRequests }),
    notes,
  };

  const reviewReady =
    reviewed.review.by === "none" || review?.verdict === "approved";
  const checksReady =
    ci === "passed" || (ci === "none" && !reviewed.requireGreenChecks);
  if (reviewReady && checksReady && detail !== undefined) {
    return {
      kind: "satisfied",
      state,
      output: proofFor({
        summary: `Reconciled: pull request #${String(summary.number)} from ${reviewed.branch} is merge-ready on head ${summary.headSha ?? "unknown"} (review ${review?.verdict ?? "not required"}, checks ${ci}).`,
        branch: reviewed.branch,
        pullRequest: summary,
        commitSha: summary.headSha,
        ...(review === undefined ? {} : { review }),
      }),
    };
  }
  return { kind: "resume", state };
}

interface PullRequestLookup {
  readonly summary: ReconciledPullRequest;
  readonly mergeCommitSha?: string;
}

async function remoteBranchExists(
  tools: Tools,
  input: ReconcileInput,
  branch: string,
  notes: string[],
): Promise<boolean> {
  const result = await tools.runner.run(
    tools.git,
    ["ls-remote", "--heads", tools.remote, `refs/heads/${branch}`],
    { cwd: input.worktreeDir, ...signalOption(input) },
  );
  if (result.exitCode !== 0) {
    notes.push(`git ls-remote failed: ${firstLine(result.stderr)}`);
    return false;
  }
  return result.stdout.trim().length > 0;
}

async function lookupPullRequest(
  tools: Tools,
  input: ReconcileInput,
  branch: string,
  targetBranch: string,
  notes: string[],
): Promise<PullRequestLookup | undefined> {
  const result = await tools.runner.run(
    tools.gh,
    [
      "pr",
      "list",
      "--head",
      branch,
      "--base",
      targetBranch,
      "--state",
      "all",
      "--limit",
      "10",
      "--json",
      "number,url,state,headRefOid,mergeCommit,mergeStateStatus",
    ],
    { cwd: input.worktreeDir, ...signalOption(input) },
  );
  if (result.exitCode !== 0) {
    notes.push(`gh pr list failed: ${firstLine(result.stderr)}`);
    return undefined;
  }
  const parsed = parseJson(result.stdout, "gh pr list");
  if (!Array.isArray(parsed)) {
    notes.push("gh pr list returned a non-array");
    return undefined;
  }
  const entries = parsed.filter(isPlainObject);
  const pick = (state: string): Record<string, unknown> | undefined =>
    entries.find((entry) => entry["state"] === state);
  const chosen = pick("MERGED") ?? pick("OPEN") ?? pick("CLOSED");
  if (chosen === undefined) {
    return undefined;
  }
  const number = chosen["number"];
  const url = chosen["url"];
  if (!Number.isInteger(number) || typeof url !== "string") {
    notes.push("gh pr list entry lacks number/url");
    return undefined;
  }
  const rawState = chosen["state"];
  const state: ReconciledPullRequest["state"] =
    rawState === "MERGED" ? "merged" : rawState === "OPEN" ? "open" : "closed";
  const headSha = optionalString(chosen["headRefOid"]);
  const mergeCommit = chosen["mergeCommit"];
  const mergeCommitSha = isPlainObject(mergeCommit)
    ? optionalString(mergeCommit["oid"])
    : undefined;
  const mergeStateStatus = optionalString(chosen["mergeStateStatus"]);
  return {
    summary: {
      number: number as number,
      url,
      state,
      ...(headSha === undefined ? {} : { headSha }),
      ...(mergeStateStatus === undefined ? {} : { mergeStateStatus }),
    },
    ...(mergeCommitSha === undefined ? {} : { mergeCommitSha }),
  };
}

interface PullRequestDetail {
  readonly headSha?: string;
  readonly headCommittedAt?: string;
  readonly ci: CiState;
  readonly reviews: readonly ReviewerResponse[];
  readonly comments: readonly ReviewerResponse[];
}

interface ReviewerResponse {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly url?: string;
  /** Formal review state when the response is a GitHub review object. */
  readonly state?: string;
  readonly commitSha?: string;
}

async function viewPullRequest(
  tools: Tools,
  input: ReconcileInput,
  number: number,
  notes: string[],
): Promise<PullRequestDetail | undefined> {
  const result = await tools.runner.run(
    tools.gh,
    [
      "pr",
      "view",
      String(number),
      "--json",
      "headRefOid,statusCheckRollup,reviews,comments,commits",
    ],
    { cwd: input.worktreeDir, ...signalOption(input) },
  );
  if (result.exitCode !== 0) {
    notes.push(`gh pr view failed: ${firstLine(result.stderr)}`);
    return undefined;
  }
  const parsed = parseJson(result.stdout, "gh pr view");
  if (!isPlainObject(parsed)) {
    notes.push("gh pr view returned a non-object");
    return undefined;
  }
  const headSha = optionalString(parsed["headRefOid"]);
  const commits = Array.isArray(parsed["commits"])
    ? parsed["commits"].filter(isPlainObject)
    : [];
  const headCommit = commits.find((commit) => commit["oid"] === headSha);
  const headCommittedAt =
    headCommit === undefined
      ? undefined
      : optionalString(headCommit["committedDate"]);
  return {
    ...(headSha === undefined ? {} : { headSha }),
    ...(headCommittedAt === undefined ? {} : { headCommittedAt }),
    ci: classifyChecks(parsed["statusCheckRollup"]),
    reviews: responsesFrom(parsed["reviews"], "submittedAt"),
    comments: responsesFrom(parsed["comments"], "createdAt"),
  };
}

function responsesFrom(
  value: unknown,
  timestampField: "submittedAt" | "createdAt",
): readonly ReviewerResponse[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const responses: ReviewerResponse[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const author = isPlainObject(entry["author"])
      ? optionalString(entry["author"]["login"])
      : undefined;
    const body = optionalString(entry["body"]) ?? "";
    const createdAt = optionalString(entry[timestampField]);
    if (author === undefined || createdAt === undefined) continue;
    const url = optionalString(entry["url"]);
    const state = optionalString(entry["state"]);
    const commit = entry["commit"];
    const commitSha = isPlainObject(commit)
      ? optionalString(commit["oid"])
      : optionalString(commit);
    responses.push({
      author,
      body,
      createdAt,
      ...(url === undefined ? {} : { url }),
      ...(state === undefined ? {} : { state }),
      ...(commitSha === undefined ? {} : { commitSha }),
    });
  }
  return responses;
}

function classifyChecks(value: unknown): CiState {
  if (!Array.isArray(value) || value.length === 0) {
    return "none";
  }
  let pending = false;
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const conclusion = optionalString(entry["conclusion"])?.toUpperCase();
    const status = optionalString(entry["status"])?.toUpperCase();
    const state = optionalString(entry["state"])?.toUpperCase();
    const verdict = conclusion ?? state;
    if (
      verdict === "FAILURE" ||
      verdict === "ERROR" ||
      verdict === "CANCELLED" ||
      verdict === "TIMED_OUT" ||
      verdict === "ACTION_REQUIRED" ||
      verdict === "STARTUP_FAILURE"
    ) {
      return "failed";
    }
    const finished =
      verdict === "SUCCESS" ||
      verdict === "NEUTRAL" ||
      verdict === "SKIPPED" ||
      status === "COMPLETED";
    if (!finished) {
      pending = true;
    }
  }
  return pending ? "pending" : "passed";
}

const IN_PROGRESS_PATTERNS = [
  /is working/i,
  /is reviewing/i,
  /review in progress/i,
  /reviewing pr/i,
];

const POSITIVE_PATTERNS = [
  /looks? good/i,
  /ready (?:to|for) merge/i,
  /good to merge/i,
  /no blockers?/i,
  /no (?:remaining |further )?actionable (?:findings|issues|concerns)/i,
  /no (?:remaining |further )?findings/i,
  /\bapproved?\b/i,
  /\blgtm\b/i,
];

const BLOCKING_PATTERNS = [
  /changes? requested/i,
  /actionable (?:finding|issue|concern)s?\b/i,
  /\bmust (?:be )?fix/i,
  /\bblocking\b/i,
  /not ready/i,
  /not approved/i,
  /request(?:ing)? changes/i,
  /### Findings?/i,
  /\*\*\d+\.\s/,
];

/** Positive negations a blocking pattern must not trip on. */
const NEGATED_POSITIVE_PATTERNS = [
  /\b(?:no|without|zero)\s+(?:remaining |further |outstanding |other )?(?:actionable |blocking )?(?:findings?|issues?|concerns?|blockers?)\b/gi,
  /\bnothing (?:actionable|blocking)\b/gi,
];

function withoutNegatedPositives(body: string): string {
  return NEGATED_POSITIVE_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, ""),
    body,
  );
}

function isBlocking(body: string): boolean {
  const stripped = withoutNegatedPositives(body);
  return BLOCKING_PATTERNS.some((pattern) => pattern.test(stripped));
}

function classifyReview(
  review: ReviewConfig,
  detail: PullRequestDetail,
): ReconciledReview {
  const reviewer = review.by;
  const logins = reviewerLogins(review);
  const since = detail.headCommittedAt;
  const isCurrent = (response: ReviewerResponse): boolean =>
    logins.has(response.author.toLowerCase()) &&
    (response.commitSha !== undefined
      ? response.commitSha === detail.headSha
      : since !== undefined && response.createdAt >= since);
  const formal = detail.reviews.filter(isCurrent);
  const comments = detail.comments.filter(isCurrent);
  const latest = [...formal, ...comments]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (latest === undefined) {
    return { reviewer, verdict: "pending", inProgress: false };
  }
  const excerpt = latest.body.slice(0, EXCERPT_LIMIT);
  const base = {
    reviewer,
    ...(latest.url === undefined ? {} : { url: latest.url }),
    ...(excerpt.length === 0 ? {} : { excerpt }),
  };
  const formalState = latest.state?.toUpperCase();
  if (formalState === "APPROVED") {
    return { ...base, verdict: "approved", inProgress: false };
  }
  if (formalState === "CHANGES_REQUESTED") {
    return { ...base, verdict: "changes_requested", inProgress: false };
  }
  const finished = /\bclaude finished\b/i.test(latest.body);
  const hasVerdict =
    isBlocking(latest.body) ||
    POSITIVE_PATTERNS.some((pattern) => pattern.test(latest.body)) ||
    /confidence score:\s*\d\s*\/\s*5/i.test(latest.body);
  const activePlaceholder = IN_PROGRESS_PATTERNS.some((pattern) =>
    pattern.test(latest.body),
  );
  const uncheckedTodo = /^\s*- \[ \] /m.test(latest.body);
  if (!finished && (activePlaceholder || (uncheckedTodo && !hasVerdict))) {
    return { ...base, verdict: "pending", inProgress: true };
  }
  if (reviewer === "greptile") {
    const score = /confidence score:\s*(\d)\s*\/\s*5/i.exec(latest.body);
    if (score !== null) {
      const confidenceScore = Number(score[1]);
      const minimum = review.minConfidenceScore ?? 5;
      const blocked = isBlocking(latest.body);
      return {
        ...base,
        confidenceScore,
        verdict:
          confidenceScore >= minimum && !blocked
            ? "approved"
            : "changes_requested",
        inProgress: false,
      };
    }
  }
  if (isBlocking(latest.body)) {
    return { ...base, verdict: "changes_requested", inProgress: false };
  }
  const positive = POSITIVE_PATTERNS.some((pattern) =>
    pattern.test(latest.body),
  );
  return {
    ...base,
    verdict: positive ? "approved" : "pending",
    inProgress: false,
  };
}

function countReviewRequests(
  review: ReviewConfig,
  detail: PullRequestDetail,
): number {
  const trigger = (
    review.triggerComment ??
    (review.by === "greptile" ? "@greptile review" : "@claude review")
  ).toLowerCase();
  return detail.comments.filter((comment) =>
    comment.body.toLowerCase().includes(trigger),
  ).length;
}

function reviewerLogins(review: ReviewConfig): ReadonlySet<string> {
  switch (review.by) {
    case "claude":
      return new Set(["claude", "claude[bot]", "claude-code[bot]"]);
    case "greptile": {
      if (review.greptileAppSlug !== undefined) {
        const slug = review.greptileAppSlug.toLowerCase();
        return new Set([slug, `${slug}[bot]`]);
      }
      return new Set([
        "greptile",
        "greptile[bot]",
        "greptile-apps",
        "greptile-apps[bot]",
      ]);
    }
    case "none":
      return new Set();
  }
}

interface ProofInput {
  readonly summary: string;
  readonly branch: string;
  readonly pullRequest: ReconciledPullRequest;
  readonly commitSha?: string | undefined;
  readonly review?: ReconciledReview | undefined;
}

function proofFor(input: ProofInput): JsonValue {
  const proof: ProofOfWorkV1 = {
    version: PROOF_OF_WORK_VERSION,
    summary: input.summary,
    commits: input.commitSha === undefined ? [] : [{ sha: input.commitSha }],
    pullRequests: [
      {
        url: input.pullRequest.url,
        number: input.pullRequest.number,
        branch: input.branch,
        ...(input.pullRequest.headSha === undefined
          ? {}
          : { headSha: input.pullRequest.headSha }),
      },
    ],
    validations: [],
    reviewVerdicts:
      input.review === undefined
        ? []
        : [
            {
              reviewer: input.review.reviewer,
              verdict: input.review.verdict,
              ...(input.review.url === undefined
                ? {}
                : { url: input.review.url }),
              ...(input.pullRequest.headSha === undefined
                ? {}
                : { headSha: input.pullRequest.headSha }),
            },
          ],
    screenshots: [],
    artifacts: [],
    unresolvedRisks: [],
  };
  return JSON.parse(JSON.stringify(proof)) as JsonValue;
}

/**
 * The branch a merge node targets, read from its upstream implement output:
 * proof-of-work pullRequests[0].branch, or the legacy metadata.branch shape.
 */
export function sourceBranchFromInput(input: JsonValue): string | undefined {
  const candidates: readonly JsonValue[] = isJsonArray(input) ? input : [input];
  for (const candidate of candidates) {
    const proof = tryParseProofOfWork(candidate);
    const proofBranch = proof?.pullRequests[0]?.branch;
    if (proofBranch !== undefined) {
      return proofBranch;
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
    if (!isPlainObject(candidate)) continue;
    const branch = optionalString(candidate["branch"]);
    if (branch !== undefined) return branch;
    const metadata = candidate["metadata"];
    if (isPlainObject(metadata)) {
      const metadataBranch = optionalString(metadata["branch"]);
      if (metadataBranch !== undefined) return metadataBranch;
    }
  }
  return undefined;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function fresh(notes: readonly string[]): ReconcileOutcome {
  return { kind: "fresh", notes: [...notes] };
}

function signalOption(input: ReconcileInput): { signal?: AbortSignal } {
  return input.signal === undefined ? {} : { signal: input.signal };
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`${source} returned invalid JSON`, { cause: error });
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function nonEmpty(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
