import type { JsonValue } from "../graph/types.js";
import { isPlainObject } from "../internal/json.js";
import type { ArtifactRef } from "./ports.js";

/** Current durable self-reported evidence schema produced by Prism's agents. */
export const PROOF_OF_WORK_VERSION = 1 as const;

export interface CommitEvidence {
  readonly sha: string;
  readonly url?: string;
}

export interface PullRequestEvidence {
  readonly url: string;
  readonly number?: number;
  readonly branch?: string;
  readonly headSha?: string;
}

export interface ValidationEvidence {
  readonly command: string;
  readonly status: "passed" | "failed";
  readonly details?: string;
}

export interface ReviewVerdictEvidence {
  readonly reviewer: string;
  readonly verdict: "approved" | "changes_requested" | "pending";
  readonly url?: string;
  readonly headSha?: string;
}

/**
 * Backend-neutral, machine-readable evidence reported by one agent node.
 * Parsing verifies only this schema, not the external truth of commits, pull
 * requests, validations, or review verdicts. Hosts that require attestation
 * must verify those references against their source systems before trusting
 * them for authorization. Artifact values are references, never local paths
 * or embedded bytes.
 */
export interface ProofOfWorkV1 {
  readonly version: typeof PROOF_OF_WORK_VERSION;
  readonly summary: string;
  readonly commits: readonly CommitEvidence[];
  readonly pullRequests: readonly PullRequestEvidence[];
  readonly validations: readonly ValidationEvidence[];
  readonly reviewVerdicts: readonly ReviewVerdictEvidence[];
  readonly screenshots: readonly ArtifactRef[];
  readonly artifacts: readonly ArtifactRef[];
  readonly unresolvedRisks: readonly string[];
}

/** Parse an untrusted agent result, rejecting malformed or partial evidence. */
export function parseProofOfWork(input: unknown): ProofOfWorkV1 {
  const value = object(input, "proof of work");
  if (value["version"] !== PROOF_OF_WORK_VERSION) {
    throw new Error(
      `proof of work version must be ${String(PROOF_OF_WORK_VERSION)}`,
    );
  }

  return Object.freeze({
    version: PROOF_OF_WORK_VERSION,
    summary: nonEmptyString(value["summary"], "summary"),
    commits: parseArray(value, "commits", parseCommit),
    pullRequests: parseArray(value, "pullRequests", parsePullRequest),
    validations: parseArray(value, "validations", parseValidation),
    reviewVerdicts: parseArray(value, "reviewVerdicts", parseReviewVerdict),
    screenshots: parseArray(value, "screenshots", parseArtifactRef),
    artifacts: parseArray(value, "artifacts", parseArtifactRef),
    unresolvedRisks: parseArray(value, "unresolvedRisks", (risk, field) =>
      nonEmptyString(risk, field),
    ),
  });
}

/** Recognize proof-of-work without making generic or legacy output unreadable. */
export function tryParseProofOfWork(input: JsonValue): ProofOfWorkV1 | null {
  if (!isPlainObject(input) || input["version"] !== PROOF_OF_WORK_VERSION) {
    return null;
  }
  try {
    return parseProofOfWork(input);
  } catch {
    return null;
  }
}

function parseCommit(input: unknown, field: string): CommitEvidence {
  const value = object(input, field);
  const url = optionalNonEmptyString(value["url"], `${field}.url`);
  return Object.freeze({
    sha: nonEmptyString(value["sha"], `${field}.sha`),
    ...(url === undefined ? {} : { url }),
  });
}

function parsePullRequest(input: unknown, field: string): PullRequestEvidence {
  const value = object(input, field);
  const number = optionalPositiveInteger(value["number"], `${field}.number`);
  const branch = optionalNonEmptyString(value["branch"], `${field}.branch`);
  const headSha = optionalNonEmptyString(value["headSha"], `${field}.headSha`);
  return Object.freeze({
    url: nonEmptyString(value["url"], `${field}.url`),
    ...(number === undefined ? {} : { number }),
    ...(branch === undefined ? {} : { branch }),
    ...(headSha === undefined ? {} : { headSha }),
  });
}

function parseValidation(input: unknown, field: string): ValidationEvidence {
  const value = object(input, field);
  const status = value["status"];
  if (status !== "passed" && status !== "failed") {
    throw new Error(`${field}.status must be "passed" or "failed"`);
  }
  const details = optionalNonEmptyString(value["details"], `${field}.details`);
  return Object.freeze({
    command: nonEmptyString(value["command"], `${field}.command`),
    status,
    ...(details === undefined ? {} : { details }),
  });
}

function parseReviewVerdict(
  input: unknown,
  field: string,
): ReviewVerdictEvidence {
  const value = object(input, field);
  const verdict = value["verdict"];
  if (
    verdict !== "approved" &&
    verdict !== "changes_requested" &&
    verdict !== "pending"
  ) {
    throw new Error(
      `${field}.verdict must be "approved", "changes_requested", or "pending"`,
    );
  }
  const url = optionalNonEmptyString(value["url"], `${field}.url`);
  const headSha = optionalNonEmptyString(value["headSha"], `${field}.headSha`);
  return Object.freeze({
    reviewer: nonEmptyString(value["reviewer"], `${field}.reviewer`),
    verdict,
    ...(url === undefined ? {} : { url }),
    ...(headSha === undefined ? {} : { headSha }),
  });
}

function parseArtifactRef(input: unknown, field: string): ArtifactRef {
  const value = object(input, field);
  const uri = nonEmptyString(value["uri"], `${field}.uri`);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(uri)) {
    throw new Error(`${field}.uri must be an ArtifactRef URI`);
  }
  const size = value["size"];
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    throw new Error(`${field}.size must be a non-negative safe integer`);
  }
  const contentType = optionalNonEmptyString(
    value["contentType"],
    `${field}.contentType`,
  );
  return Object.freeze({
    uri,
    filename: nonEmptyString(value["filename"], `${field}.filename`),
    size: size as number,
    ...(contentType === undefined ? {} : { contentType }),
  });
}

function parseArray<T>(
  parent: Record<string, unknown>,
  field: string,
  parse: (input: unknown, field: string) => T,
): readonly T[] {
  const input = parent[field];
  if (!Array.isArray(input)) {
    throw new Error(`${field} must be an array`);
  }
  return Object.freeze(
    input.map((entry, index) => parse(entry, `${field}[${String(index)}]`)),
  );
}

function object(input: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw new Error(`${field} must be a plain object`);
  }
  return input;
}

function nonEmptyString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return input;
}

function optionalNonEmptyString(
  input: unknown,
  field: string,
): string | undefined {
  return input === undefined ? undefined : nonEmptyString(input, field);
}

function optionalPositiveInteger(
  input: unknown,
  field: string,
): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return input as number;
}
