import type { JsonValue } from "../graph/types.js";
import { isAdjudicated, resolveFailureClass } from "./retry.js";
import type { FailureClass, NodeFailure } from "./types.js";

/**
 * How an operator should read a failure (plan §16). Pure and render-time:
 * it also classifies failures recorded before `needs_input` existed, so an
 * older run reads correctly in a newer prism.
 *
 * - `transient`: infrastructure bad luck (a lost git lock, an interruption).
 * - `needs_input`: a worker stopped on a declared blocker only an operator
 *   can clear. Never retried automatically.
 * - `genuine`: the work itself failed; read the logs.
 */
export type FailureDisposition = "transient" | "needs_input" | "genuine";

export interface FailureDescription {
  readonly nodeId: string;
  readonly disposition: FailureDisposition;
  /** First line of the failure's message, bounded for one-line display. */
  readonly summary: string;
  /** The pull request the worker left, when the failure records one. */
  readonly pullRequestUrl?: string;
  /** One-line next action for the operator. */
  readonly hint: string;
}

/**
 * Language a worker uses when it stops on a blocker rather than failing the
 * work. Matched only against worker-declared (adjudicated) failures.
 */
const DECLARED_BLOCKER =
  /\b(?:blocked|blocker|needs? (?:operator|owner|human|user|your) (?:input|decision|approval)|awaiting (?:operator|owner|human|user) (?:input|decision|approval)|clarification (?:request|needed|required))\b/iu;

/** Whether a worker's error text declares a blocker needing an operator. */
export function isDeclaredBlocker(error: string): boolean {
  return DECLARED_BLOCKER.test(error);
}

/**
 * The failure class to RECORD for a worker-declared failure: `needs_input`
 * when the worker said so or its error declares a blocker; otherwise the
 * worker's own class, unchanged.
 */
export function classifyWorkerFailure(worker: {
  readonly error?: string;
  readonly failureClass?: FailureClass;
}): FailureClass | undefined {
  if (worker.failureClass === "needs_input") return "needs_input";
  if (worker.error !== undefined && isDeclaredBlocker(worker.error)) {
    return "needs_input";
  }
  return worker.failureClass;
}

export function failureDisposition(failure: NodeFailure): FailureDisposition {
  if (failure.failureClass === "needs_input") return "needs_input";
  if (isAdjudicated(failure)) {
    const error = causeField(failure.cause, "error");
    return typeof error === "string" && isDeclaredBlocker(error)
      ? "needs_input"
      : "genuine";
  }
  return resolveFailureClass(failure) === "transient_infra"
    ? "transient"
    : "genuine";
}

export interface DescribeFailureContext {
  readonly runId: string;
  /** Whether the run has finished (no live coordinator). */
  readonly finished: boolean;
}

/** Classify a failure and phrase it for an operator (pure). */
export function describeFailure(
  failure: NodeFailure,
  context: DescribeFailureContext,
): FailureDescription {
  const disposition = failureDisposition(failure);
  const pullRequestUrl = pullRequestUrlOf(failure.cause);
  const { runId } = context;
  const { nodeId } = failure;
  const hint =
    disposition === "needs_input"
      ? `resolve the blocker, then: prism rerun-node ${runId} ${nodeId}`
      : disposition === "transient"
        ? context.finished
          ? `transient — prism resume ${runId} re-runs it`
          : `transient, retries exhausted — prism rerun-node ${runId} ${nodeId} retries it now`
        : `inspect the logs: prism logs ${runId}`;
  return Object.freeze({
    nodeId,
    disposition,
    summary: summarize(failure.cause),
    ...(pullRequestUrl === undefined ? {} : { pullRequestUrl }),
    hint,
  });
}

const SUMMARY_LIMIT = 200;

function summarize(cause: JsonValue): string {
  const text = messageOf(cause) ?? JSON.stringify(cause);
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim() !== "");
  const line = (firstLine ?? text).trim();
  return line.length > SUMMARY_LIMIT
    ? `${line.slice(0, SUMMARY_LIMIT - 1)}…`
    : line;
}

function messageOf(cause: JsonValue): string | undefined {
  if (typeof cause === "string") return cause;
  const error = causeField(cause, "error");
  if (typeof error === "string") return error;
  const nested = causeField(error ?? null, "message");
  if (typeof nested === "string") return nested;
  const message = causeField(cause, "message");
  if (typeof message === "string") return message;
  const code = causeField(cause, "code");
  return typeof code === "string" ? code : undefined;
}

function causeField(cause: JsonValue, field: string): JsonValue | undefined {
  if (typeof cause !== "object" || cause === null || Array.isArray(cause)) {
    return undefined;
  }
  return (cause as { readonly [key: string]: JsonValue })[field];
}

function pullRequestUrlOf(cause: JsonValue): string | undefined {
  const state = causeField(cause, "state");
  const pullRequest = causeField(state ?? null, "pullRequest");
  const url = causeField(pullRequest ?? null, "url");
  return typeof url === "string" ? url : undefined;
}
