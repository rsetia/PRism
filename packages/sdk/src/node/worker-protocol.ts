import type { JsonValue, NodeKind } from "../graph/types.js";
import { isJsonValue, isPlainObject } from "../internal/json.js";
import type { FailureClass } from "../runtime/types.js";

/**
 * The file protocol between the orchestrator and a worker subprocess
 * (plan §14, from PRism-py's `.prism_node/`). The orchestrator writes the
 * spec; the worker writes heartbeats and, at the end, a result. Files,
 * not stdout, so a crashed or chatty process can't corrupt the channel.
 */
export const WORKER_SPEC_FILE = "spec.json";
export const WORKER_RESULT_FILE = "result.json";
export const WORKER_HEARTBEAT_FILE = "heartbeat.json";

/** Env var telling the worker which directory holds its protocol files. */
export const NODE_DIR_ENV_VAR = "PRISM_NODE_DIR";

/**
 * What the orchestrator hands a worker: everything it needs to do the
 * node's work, as serializable data. `input` is the already-shaped
 * upstream data (the deferred §13 shapeInput becomes load-bearing here —
 * the engine shapes inputs, then serializes them into this spec).
 */
export interface WorkerSpec {
  readonly runId: string;
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly executor: string;
  /** The node's shaped input; `null` when it has no upstreams. */
  readonly input: JsonValue;
  /** The node's opaque config, or `null`. */
  readonly config: JsonValue | null;
  /** 1-based attempt number, so a worker can label its own retries. */
  readonly attempt: number;
}

/**
 * What a worker writes to result.json. `output` on success, `error` on
 * failure — a worker classifies its own failure so the engine's retry
 * policy can act on it (unclassified defaults to transient_infra).
 */
export interface WorkerResult {
  readonly status: "succeeded" | "failed";
  readonly output?: JsonValue;
  readonly error?: string;
  readonly failureClass?: FailureClass;
}

/** A worker's liveness beacon, rewritten on a regular interval. */
export interface Heartbeat {
  /** Epoch milliseconds of the most recent beat. */
  readonly ts: number;
}

const FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set([
  "transient_infra",
  "timeout",
  "validation_failed",
  "semantic_failed",
  "merge_conflict",
  "policy_denied",
  "manual_review_required",
]);

function invalidWorkerResult(message: string): never {
  throw new Error(`Invalid worker result: ${message}`);
}

/**
 * Parse an untrusted result.json into a WorkerResult. The worker is a
 * separate process — its output crosses a trust boundary, so validate it
 * like any external input (same discipline as parseGraph).
 */
export function parseWorkerResult(input: unknown): WorkerResult {
  if (!isPlainObject(input)) {
    return invalidWorkerResult("expected an object");
  }

  const status = input["status"];
  if (status === "succeeded") {
    if (!Object.hasOwn(input, "output") || !isJsonValue(input["output"])) {
      return invalidWorkerResult(
        'a succeeded result must contain a JSON-safe "output"',
      );
    }

    return { status, output: input["output"] };
  }

  if (status === "failed") {
    const error = input["error"];
    if (typeof error !== "string") {
      return invalidWorkerResult(
        'a failed result must contain a string "error"',
      );
    }

    if (!Object.hasOwn(input, "failureClass")) {
      return { status, error };
    }

    const failureClass = input["failureClass"];
    if (
      typeof failureClass !== "string" ||
      !FAILURE_CLASSES.has(failureClass as FailureClass)
    ) {
      return invalidWorkerResult(
        `unknown failureClass ${String(failureClass)}`,
      );
    }

    return { status, error, failureClass: failureClass as FailureClass };
  }

  return invalidWorkerResult('status must be "succeeded" or "failed"');
}
