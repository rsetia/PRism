import type { JsonValue } from "../graph/types.js";
import { isPlainObject } from "../internal/json.js";
import type { ReviewGate } from "../beads/generate.js";
import type { CodexExecutorContract } from "./codex-engine.js";
import type { WorkerSpec } from "./worker-protocol.js";

/**
 * The prompt contracts for the codex-engine executors (plan §15). This is
 * where PRism-py's whole review-loop behavior lives: `implement` and
 * `merge_resolve` are one codex engine driven by different instructions
 * and permissions. Porting these contracts faithfully IS porting the
 * behavior — the agent loops, polls review, and merges because the prompt
 * tells it to.
 *
 * Pure: config in, contract out. No process launching here — the engine
 * runs codex; this module only decides what to tell it.
 */

export interface WorkItem {
  readonly provider: string;
  readonly id: string;
  readonly url?: string;
  readonly title?: string;
}

export interface ReviewConfig {
  readonly by: ReviewGate;
  /** Restrict Greptile feedback to this GitHub App slug when configured. */
  readonly greptileAppSlug?: string;
  readonly minConfidenceScore?: number;
  /**
   * Legacy compatibility flag. For comment-only reviewer integrations, an
   * unambiguous positive verdict on the current head satisfies approval; a
   * formal GitHub review object is not required.
   */
  readonly requireApproved?: boolean;
  readonly requireNoActionableFindings?: boolean;
  readonly requireGreenChecks?: boolean;
  readonly allowConfidenceFourWithoutActionableFindings?: boolean;
  readonly triggerComment?: string;
}

export interface ImplementConfig {
  readonly workItem: WorkItem;
  readonly targetBranch: string;
  readonly branchName?: string;
  readonly review: ReviewConfig;
  readonly maxIterations?: number;
  readonly validationCommands?: readonly string[];
}

export interface MergeResolveConfig {
  readonly targetBranch: string;
  /** Upstream node whose output/metadata names the feature branch. */
  readonly sourceBranchFrom: string;
  readonly mergeMethod?: "squash" | "merge" | "rebase";
  readonly validationCommands?: readonly string[];
}

export interface FinalizePrConfig {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly review: ReviewConfig;
  readonly draft?: boolean;
  readonly title?: string;
  readonly body?: string;
  readonly maxIterations?: number;
  readonly validationCommands?: readonly string[];
}

/**
 * Validate and extract a node's config for `implement`. Doubles as the
 * executor's preflight `validateConfig` (throws on anything invalid).
 *
 * Validation contract:
 * - require a plain object
 * - workItem: object with a non-empty string id; provider defaults to
 *   "beads"; url/title optional strings
 * - targetBranch: non-empty string (default "main")
 * - review: { by } one of "greptile" | "claude" | "none"; the numeric and
 *   boolean sub-fields are optional but type-checked when present
 * - maxIterations: positive integer when present
 * - validationCommands: string[] when present
 * - throw an Error naming the offending field
 */
export function parseImplementConfig(
  config: JsonValue | undefined,
): ImplementConfig {
  const value = expectObject(config, "config");
  const workItemValue = expectObject(value["workItem"], "config.workItem");
  const reviewValue = expectObject(value["review"], "config.review");

  const provider =
    workItemValue["provider"] === undefined
      ? "beads"
      : expectNonEmptyString(
          workItemValue["provider"],
          "config.workItem.provider",
        );
  const id = expectNonEmptyString(workItemValue["id"], "config.workItem.id");
  const url = optionalNonEmptyString(
    workItemValue["url"],
    "config.workItem.url",
  );
  const title = optionalString(workItemValue["title"], "config.workItem.title");

  const by = parseReviewGate(reviewValue["by"]);
  const greptileAppSlug = optionalNonEmptyString(
    reviewValue["greptileAppSlug"],
    "config.review.greptileAppSlug",
  );
  if (greptileAppSlug !== undefined && by !== "greptile") {
    throw new Error(
      'config.review.greptileAppSlug requires config.review.by to be "greptile"',
    );
  }
  const minConfidenceScore = optionalConfidenceScore(
    reviewValue["minConfidenceScore"],
    "config.review.minConfidenceScore",
  );
  const requireApproved = optionalBoolean(
    reviewValue["requireApproved"],
    "config.review.requireApproved",
  );
  const requireNoActionableFindings = optionalBoolean(
    reviewValue["requireNoActionableFindings"],
    "config.review.requireNoActionableFindings",
  );
  const requireGreenChecks = optionalBoolean(
    reviewValue["requireGreenChecks"],
    "config.review.requireGreenChecks",
  );
  const allowConfidenceFourWithoutActionableFindings = optionalBoolean(
    reviewValue["allowConfidenceFourWithoutActionableFindings"],
    "config.review.allowConfidenceFourWithoutActionableFindings",
  );
  const triggerComment = optionalNonEmptyString(
    reviewValue["triggerComment"],
    "config.review.triggerComment",
  );

  const targetBranch =
    value["targetBranch"] === undefined
      ? "main"
      : expectNonEmptyString(value["targetBranch"], "config.targetBranch");
  const branchName = optionalNonEmptyString(
    value["branchName"],
    "config.branchName",
  );
  const maxIterations = optionalPositiveInteger(
    value["maxIterations"],
    "config.maxIterations",
  );
  const validationCommands = optionalCommandList(
    value["validationCommands"],
    "config.validationCommands",
  );

  const workItem: WorkItem = Object.freeze({
    provider,
    id,
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
  });
  const review: ReviewConfig = Object.freeze({
    by,
    ...(greptileAppSlug === undefined ? {} : { greptileAppSlug }),
    ...(minConfidenceScore === undefined ? {} : { minConfidenceScore }),
    ...(requireApproved === undefined ? {} : { requireApproved }),
    ...(requireNoActionableFindings === undefined
      ? {}
      : { requireNoActionableFindings }),
    ...(requireGreenChecks === undefined ? {} : { requireGreenChecks }),
    ...(allowConfidenceFourWithoutActionableFindings === undefined
      ? {}
      : { allowConfidenceFourWithoutActionableFindings }),
    ...(triggerComment === undefined ? {} : { triggerComment }),
  });

  return Object.freeze({
    workItem,
    targetBranch,
    ...(branchName === undefined ? {} : { branchName }),
    review,
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(validationCommands === undefined ? {} : { validationCommands }),
  });
}

/**
 * Validate and extract a node's config for `merge_resolve`.
 *
 * Per MergeResolveConfig: require
 * targetBranch and sourceBranchFrom (non-empty strings); mergeMethod, when
 * present, is one of squash/merge/rebase (default squash);
 * validationCommands string[] when present.
 */
export function parseMergeResolveConfig(
  config: JsonValue | undefined,
): MergeResolveConfig {
  const value = expectObject(config, "config");
  const targetBranch = expectNonEmptyString(
    value["targetBranch"],
    "config.targetBranch",
  );
  const sourceBranchFrom = expectNonEmptyString(
    value["sourceBranchFrom"],
    "config.sourceBranchFrom",
  );
  const mergeMethod = parseMergeMethod(value["mergeMethod"]);
  const validationCommands = optionalCommandList(
    value["validationCommands"],
    "config.validationCommands",
  );

  return Object.freeze({
    targetBranch,
    sourceBranchFrom,
    mergeMethod,
    ...(validationCommands === undefined ? {} : { validationCommands }),
  });
}

/** Validate the final integration-PR review loop configuration. */
export function parseFinalizePrConfig(
  config: JsonValue | undefined,
): FinalizePrConfig {
  const value = expectObject(config, "config");
  const sourceBranch = expectNonEmptyString(
    value["sourceBranch"],
    "config.sourceBranch",
  );
  const targetBranch = expectNonEmptyString(
    value["targetBranch"],
    "config.targetBranch",
  );
  if (sourceBranch === targetBranch) {
    throw new Error("config.sourceBranch must differ from config.targetBranch");
  }
  const shared = parseImplementConfig({
    workItem: { provider: "prism", id: "final-integration-pr" },
    targetBranch,
    review: value["review"] as JsonValue,
    ...(value["maxIterations"] === undefined
      ? {}
      : { maxIterations: value["maxIterations"] as JsonValue }),
    ...(value["validationCommands"] === undefined
      ? {}
      : { validationCommands: value["validationCommands"] as JsonValue }),
  });
  const draft = optionalBoolean(value["draft"], "config.draft");
  const title = optionalNonEmptyString(value["title"], "config.title");
  const body = optionalNonEmptyString(value["body"], "config.body");
  return Object.freeze({
    sourceBranch,
    targetBranch,
    review: shared.review,
    ...(draft === undefined ? {} : { draft }),
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body }),
    ...(shared.maxIterations === undefined
      ? {}
      : { maxIterations: shared.maxIterations }),
    ...(shared.validationCommands === undefined
      ? {}
      : { validationCommands: shared.validationCommands }),
  });
}

/**
 * Build the `implement` contract (plan §15, ported from PRism-py
 * executors.py `task/implement`).
 *
 * The instructions tell the agent to:
 * - implement the work item (from executor input + config.workItem) inside
 *   the provided worktree; do NOT require a GitHub issue unless
 *   workItem.provider is "github"
 * - run validationCommands, commit, push branchName (or a generated
 *   branch), open/update a PR against targetBranch
 * - drive the review gate by review.by:
 *     greptile — post triggerComment (default "@greptile review"), poll
 *       Greptile feedback ("Confidence Score: N/5", inline comments), honor
 *       minConfidenceScore and
 *       allowConfidenceFourWithoutActionableFindings
 *     claude   — post triggerComment (default "@claude review"), treat
 *       CHANGES_REQUESTED and unresolved inline comments as actionable, and
 *       infer readiness from the latest substantive current-head response
 *     none     — gate on CI checks only
 * - after each push, poll only current-head feedback + checks, fix, repeat
 *   until merge-ready or maxIterations is reached
 * - write result.json with metadata { branch (required, exact git branch),
 *   pr_number, head_sha, review_state, greptile_confidence }
 *
 * Permissions: allowsGitMutation true, allowsGitHubIo true, and trusted host
 * access so Git can update shared worktree metadata and `gh` can reach GitHub.
 * extraRules: prefer the `gh` CLI; the sheperd helper if present; per-gate
 * polling nuances. (See PRism-py codex_extra_rules.)
 */
export function buildImplementContract(
  config: ImplementConfig,
): CodexExecutorContract {
  const branchInstruction =
    config.branchName === undefined
      ? "Create a focused feature branch with a stable, descriptive name; record its exact name in the result metadata."
      : `Use the feature branch ${quote(config.branchName)}; record that exact branch name in the result metadata.`;
  const validationInstruction =
    config.validationCommands === undefined ||
    config.validationCommands.length === 0
      ? "Run the repository's relevant validation before every final push."
      : `Run every configured validation command before every final push, in order: ${config.validationCommands
          .map(quote)
          .join(", ")}.`;
  const maxIterations = config.maxIterations ?? 8;
  const workItemDetails = [
    `provider=${quote(config.workItem.provider)}`,
    `id=${quote(config.workItem.id)}`,
    ...(config.workItem.url === undefined
      ? []
      : [`url=${quote(config.workItem.url)}`]),
    ...(config.workItem.title === undefined
      ? []
      : [`title=${quote(config.workItem.title)}`]),
  ].join(", ");
  const gateInstructions = implementGateInstructions(config.review);

  const instructions = `Implement the configured work item end to end inside the provided worktree.

Work item:
- Use spec.input as the task body and upstream context, together with config.workItem (${workItemDetails}).
- Generated Beads graphs put the full snapshotted bead record first: spec.input is that record for an independent bead, or [beadRecord, ...upstreamResults] when it has dependencies.
- Do not require a GitHub issue number unless config.workItem.provider is "github".
- When the provider is "beads", create or update the PR body from the snapshotted Beads context in spec.input. Include the bead id, title, description, acceptance criteria when present, dependencies, validation plan, and its beads:// URL.

Implementation and pull request:
- Make only changes needed for this work item.
- ${branchInstruction}
- ${validationInstruction}
- Commit the completed changes, push the feature branch, and create or update a pull request targeting ${quote(config.targetBranch)}.

Review loop:
${gateInstructions}
- After every push, capture the new head SHA and the push time. Ignore stale reviews, comments, and checks from older heads; poll only feedback and CI/check results applicable to the current head.
- Fix current-head actionable findings and failing checks, rerun validation, commit, and push before polling again.
- Count implementation/review iterations only within this worker invocation. When a reset re-enters an existing branch or pull request, start the iteration count at zero; never count historical commits, comments, review cycles, or a prior failed result against this invocation's budget.
- Stop successfully only when the configured review gate is merge-ready. Perform at most ${String(maxIterations)} implementation/review iterations. If the limit is reached first, write a failed result with failureClass "manual_review_required".

Result:
- On success, write result.json through the worker protocol as {"status":"succeeded","output":{"summary":"<concise summary>","metadata":{"branch":"<exact git branch>","pr_number":<number-or-null>,"head_sha":"<final head SHA>","review_state":"<approved|changes_requested|pending|null>","greptile_confidence":<number-or-null>}}}.
- metadata.branch is required and must be the exact checked-out feature branch. Never substitute a node id, work-item id, or display label.`;

  return freezeContract({
    instructions,
    dangerouslyBypassApprovalsAndSandbox: true,
    allowsGitMutation: true,
    allowsGitHubIo: true,
    extraRules: implementExtraRules(config.review),
  });
}

/**
 * Build the `merge_resolve` contract (plan §15, ported from PRism-py
 * `task/merge_resolve`).
 *
 * Instructions: read sourceBranchFrom to find the
 * feature branch (from that upstream's output text or metadata.branch),
 * find/create the PR into targetBranch, merge cleanly if possible;
 * otherwise rebase onto origin/targetBranch, resolve conflicts
 * semantically, run validationCommands, force-with-lease push, merge via
 * GitHub using mergeMethod (default squash). Never direct-push the target.
 * result.json metadata { branch, pr_number, head_sha, merge_commit }.
 * Permissions: allowsGitMutation, allowsGitHubIo, and trusted host access.
 */
export function buildMergeResolveContract(
  config: MergeResolveConfig,
): CodexExecutorContract {
  const validationInstruction =
    config.validationCommands === undefined ||
    config.validationCommands.length === 0
      ? "Run the repository's relevant validation after resolving any conflicts."
      : `After resolving conflicts, run every validation command in order: ${config.validationCommands
          .map(quote)
          .join(", ")}.`;
  const instructions = `Make the configured feature branch mergeable and merge it through GitHub.

Source and pull request:
- Read the upstream result identified by config.sourceBranchFrom (${quote(config.sourceBranchFrom)}) in spec.input. Extract the exact feature branch from its output text or metadata.branch; do not treat the upstream node id as a branch name.
- Find or create the GitHub pull request from that feature branch into ${quote(config.targetBranch)}.
- If GitHub reports that the PR can merge cleanly, merge it through GitHub using the ${config.mergeMethod ?? "squash"} method.

Conflict resolution:
- If the PR conflicts, fetch origin, check out the feature branch, and rebase it onto ${quote(`origin/${config.targetBranch}`)}.
- Resolve every conflict semantically: read both sides, preserve their compatible intent, edit the files, stage them, and continue the rebase.
- ${validationInstruction}
- Push only the rebased feature branch with --force-with-lease, then merge the PR through GitHub using the ${config.mergeMethod ?? "squash"} method.
- Never direct-push ${quote(config.targetBranch)}. GitHub must perform the final merge so the pull request closes and branch state remains consistent.

Result:
- On success, write result.json through the worker protocol as {"status":"succeeded","output":{"summary":"<concise merge summary>","metadata":{"branch":"<exact feature branch>","pr_number":<number>,"head_sha":"<final feature head SHA>","merge_commit":"<merge commit SHA or null>"}}}.`;

  return freezeContract({
    instructions,
    dangerouslyBypassApprovalsAndSandbox: true,
    allowsGitMutation: true,
    allowsGitHubIo: true,
    extraRules: [
      "Use `gh pr list`, `gh pr view`, `gh pr create`, and `gh pr merge` for pull request lookup, creation, inspection, and merging.",
      `Operate only on the source feature branch discovered from ${config.sourceBranchFrom} and target branch ${config.targetBranch}.`,
      "Never push directly to the target branch and never push or merge unrelated branches.",
      "If required checks are pending, wait for the normal GitHub merge path instead of locally pushing the target branch.",
      "Update the worker heartbeat regularly while waiting for GitHub checks or mergeability state.",
    ],
  });
}

/** Build the current-head review/fix loop for the final integration PR. */
export function buildFinalizePrContract(
  config: FinalizePrConfig,
): CodexExecutorContract {
  const validationInstruction =
    config.validationCommands === undefined ||
    config.validationCommands.length === 0
      ? "Run the repository's complete relevant validation before every final push."
      : `Run every configured validation command before every final push, in order: ${config.validationCommands
          .map(quote)
          .join(", ")}.`;
  const titleInstruction =
    config.title === undefined
      ? "Derive a concise title from the integration branch commits."
      : `Use ${quote(config.title)} as the pull request title.`;
  const bodyInstruction =
    config.body === undefined
      ? "Create a structured body summarizing the integrated work, motivation, user impact, and validation."
      : `Use this configured pull request body: ${quote(config.body)}.`;
  const draftInstruction =
    config.draft === true
      ? "Keep the pull request in draft state."
      : "Ensure the pull request is ready for review, not a draft.";
  const maxIterations = config.maxIterations ?? 8;

  const instructions = `Finalize the completed integration branch through a reviewed pull request without merging it.

Branch and pull request:
- The completed integration branch is ${quote(config.sourceBranch)} and the base branch is ${quote(config.targetBranch)}.
- Fetch both remote branches. In the provided isolated worktree, make the current temporary branch exactly match ${quote(`origin/${config.sourceBranch}`)}. Do not create a parallel feature branch.
- Open or reuse the pull request whose head is ${quote(config.sourceBranch)} and whose base is ${quote(config.targetBranch)}.
- ${titleInstruction}
- ${bodyInstruction}
- ${draftInstruction}
- Never merge or close the pull request and never push directly to ${quote(config.targetBranch)}.

Validation and review loop:
- ${validationInstruction}
${implementGateInstructions(config.review)}
- After every push, capture the new head SHA and push time. Ignore stale reviews, comments, and checks from older heads.
- Fix every current-head actionable integration finding on the temporary worktree branch, rerun validation, commit, and push with an explicit refspec from HEAD to ${quote(config.sourceBranch)}.
- Re-request review after each fix push because approval for an older head is stale.
- Perform at most ${String(maxIterations)} fix/review iterations. If the limit is reached, fail with failureClass "manual_review_required".
- Succeed only when the current head has the configured review verdict and required green checks. Leave the reviewed pull request open for human merge.

Result:
- On success, write result.json through the worker protocol as {"status":"succeeded","output":{"summary":"<concise finalization summary>","metadata":{"branch":${quote(config.sourceBranch)},"pr_number":<number>,"head_sha":"<final head SHA>","review_state":"<approved|pending|null>","ready_for_human_merge":true}}}.`;

  return freezeContract({
    instructions,
    dangerouslyBypassApprovalsAndSandbox: true,
    allowsGitMutation: true,
    allowsGitHubIo: true,
    extraRules: Object.freeze([
      ...implementExtraRules(config.review),
      `Operate only on integration branch ${config.sourceBranch} and base branch ${config.targetBranch}.`,
      "Never merge the final integration pull request; success means reviewed and ready for a human merge.",
    ]),
  });
}

/**
 * Dispatch a worker spec to its codex contract, parsing config along the
 * way. This is what a codex worker entry calls to turn spec.executor into
 * the instructions codex runs.
 *
 * Switch on spec.executor —
 *   "implement"     -> buildImplementContract(parseImplementConfig(config))
 *   "merge_resolve" -> buildMergeResolveContract(parseMergeResolveConfig(config))
 * Any other executor name is an error (a codex worker was launched for a
 * non-codex node).
 */
export function codexContractForSpec(spec: WorkerSpec): CodexExecutorContract {
  switch (spec.executor) {
    case "implement":
      return buildImplementContract(parseImplementConfig(spec.config));
    case "merge_resolve":
      return buildMergeResolveContract(parseMergeResolveConfig(spec.config));
    case "finalize_pr":
      return buildFinalizePrContract(parseFinalizePrConfig(spec.config));
    default:
      throw new Error(
        `Unsupported Codex executor ${quote(spec.executor)} for node ${quote(spec.nodeId)}`,
      );
  }
}

const REVIEW_GATES: ReadonlySet<string> = new Set([
  "greptile",
  "claude",
  "none",
]);

const MERGE_METHODS: ReadonlySet<string> = new Set([
  "squash",
  "merge",
  "rebase",
]);

function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${field} must be a plain object`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
): string | undefined {
  return value === undefined ? undefined : expectNonEmptyString(value, field);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string when provided`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean when provided`);
  }
  return value;
}

function optionalConfidenceScore(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 5
  ) {
    throw new Error(`${field} must be an integer from 1 to 5`);
  }
  return value as number;
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function optionalCommandList(
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }

  const commands = value.map((command, index) => {
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error(`${field}[${String(index)}] must be a non-empty string`);
    }
    return command;
  });
  return Object.freeze(commands);
}

function parseReviewGate(value: unknown): ReviewGate {
  if (typeof value !== "string" || !REVIEW_GATES.has(value)) {
    throw new Error('config.review.by must be "greptile", "claude", or "none"');
  }
  return value as ReviewGate;
}

function parseMergeMethod(value: unknown): "squash" | "merge" | "rebase" {
  if (value === undefined) {
    return "squash";
  }
  if (typeof value !== "string" || !MERGE_METHODS.has(value)) {
    throw new Error(
      'config.mergeMethod must be "squash", "merge", or "rebase"',
    );
  }
  return value as "squash" | "merge" | "rebase";
}

function implementGateInstructions(review: ReviewConfig): string {
  const criteria = [
    review.requireNoActionableFindings === undefined
      ? undefined
      : `requireNoActionableFindings=${String(review.requireNoActionableFindings)}`,
    review.requireGreenChecks === undefined
      ? undefined
      : `requireGreenChecks=${String(review.requireGreenChecks)}`,
  ].filter((criterion): criterion is string => criterion !== undefined);
  const criteriaInstruction =
    criteria.length === 0
      ? ""
      : ` Honor these explicit criteria: ${criteria.join(", ")}.`;

  switch (review.by) {
    case "greptile": {
      const minimum = review.minConfidenceScore ?? 5;
      const trigger = review.triggerComment ?? "@greptile review";
      const appFilter =
        review.greptileAppSlug === undefined
          ? ""
          : `\n- Restrict Greptile feedback to the GitHub App slug ${quote(review.greptileAppSlug)}. For Greptile check runs, require check_run.app.slug === ${quote(review.greptileAppSlug)}. For Greptile issue comments, review summaries, reviews, and inline review comments, require the author login to be ${quote(review.greptileAppSlug)} or ${quote(`${review.greptileAppSlug}[bot]`)}. Ignore every other Greptile app identity, including staging apps.\n- Apply that app-identity filter before making code changes, extracting a score, deciding whether a finding is actionable, waiting for review, evaluating Greptile's green check, or counting a review iteration. A response from another Greptile app does not satisfy the gate; if it responds first, keep waiting for ${quote(review.greptileAppSlug)}.`;
      const confidenceFour =
        review.allowConfidenceFourWithoutActionableFindings === true
          ? "When the configured minimum is 5 and Greptile reports 4/5, you may accept it only when no current-head actionable findings remain and all required checks are green; record safe_confidence_4_exception_applied=true in metadata."
          : "Do not accept a Greptile confidence score below the configured minimum.";
      return `- Use Greptile as the review gate. Read current-head summary comments containing "Confidence Score: N/5", inline review comments, and Greptile-generated test or issue comments.${appFilter}
- Use the latest substantive Greptile response that applies to the current head. Require a confidence score of at least ${String(minimum)}/5 from that response and apply current-head actionable-finding and check requirements; never reuse a score from an older head.${criteriaInstruction}
- Post ${quote(trigger)} after a new head needs review, then wait for Greptile feedback on that head.
- ${confidenceFour}`;
    }
    case "claude": {
      const trigger = review.triggerComment ?? "@claude review";
      const legacyApproval =
        review.requireApproved === true
          ? "The legacy requireApproved=true setting means require this positive semantic verdict; it does not require a formal GitHub review object."
          : "A formal GitHub APPROVED review object is sufficient evidence, but is not required.";
      return `- Use the Claude GitHub review app as the review gate. Post ${quote(trigger)} after a new head needs review, then wait for a substantive Claude response that applies to that head.
- Read the entire latest substantive Claude-authored current-head response, whether it is an issue comment, review summary, or formal review. Ignore trigger acknowledgements, reactions, job-start messages, author summaries, and responses that predate the latest push.
- Infer the verdict from that response. The gate is ready only when Claude unambiguously concludes that the changes look good, are ready or good to merge, have no blockers, or have no remaining actionable findings, or gives an equivalent positive conclusion. ${legacyApproval}
- Treat formal CHANGES_REQUESTED reviews, unresolved current-head inline comments, requested fixes, blocking concerns, or any statement that the change is not ready as actionable. A mixed response containing findings is not ready even if it is generally positive; "review completed" alone is not approval.${criteriaInstruction}`;
    }
    case "none":
      return `- Do not request or wait for bot review. Gate only on validation and CI/check results for the current head.${criteriaInstruction}`;
  }
}

function implementExtraRules(review: ReviewConfig): readonly string[] {
  const gateRule =
    review.by === "greptile"
      ? review.greptileAppSlug === undefined
        ? "For Greptile, use only the latest current-head confidence score and consider current-head summary concerns, inline review comments, and reviewer-generated test or issue feedback actionable unless clearly stale or explicitly non-actionable."
        : `For Greptile, consume only current-head feedback from GitHub App slug ${quote(review.greptileAppSlug)} and its ${quote(`${review.greptileAppSlug}[bot]`)} author identity; discard all other app feedback before any action or gate decision.`
      : review.by === "claude"
        ? "For Claude, post the configured trigger comment and infer readiness from the latest substantive current-head Claude response; a formal GitHub approval object is not required."
        : "With review.by set to none, do not manufacture a reviewer approval requirement; use validation and current-head checks.";

  return Object.freeze([
    "Prefer the local `gh` CLI for GitHub reads and writes.",
    "If `~/.codex/skills/sheperd/scripts/sheperd.py` exists, prefer it for pull request creation or reuse and review polling.",
    gateRule,
    "Update the worker heartbeat regularly, especially while waiting for review or CI.",
    "Stop only when the configured merge-ready criteria are satisfied or a hard failure such as the maximum iteration count is reached.",
  ]);
}

function freezeContract(
  contract: CodexExecutorContract,
): CodexExecutorContract {
  return Object.freeze({
    ...contract,
    ...(contract.extraRules === undefined
      ? {}
      : { extraRules: Object.freeze([...contract.extraRules]) }),
  });
}

function quote(value: string): string {
  return JSON.stringify(value);
}
