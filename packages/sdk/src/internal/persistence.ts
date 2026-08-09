import type { JsonValue } from "../graph/types.js";
import type { PersistedRunEvent, RunEvent } from "../runtime/events.js";
import type {
  FailureClass,
  NodeFailure,
  RunOutcome,
} from "../runtime/types.js";
import { isJsonValue, isPlainObject } from "./json.js";

const FAILURE_CLASSES = new Set([
  "transient_infra",
  "timeout",
  "validation_failed",
  "semantic_failed",
  "merge_conflict",
  "policy_denied",
  "manual_review_required",
]);

/** Clone and deeply freeze JSON data at a persistence boundary. */
export function snapshotJsonValue(value: unknown, label: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new Error(`${label} must be JSON-safe`);
  }
  return deepFreeze(cloneJsonValue(value));
}

export function snapshotNodeFailure(
  value: unknown,
  label = "node failure",
): NodeFailure {
  if (!isPlainObject(value) || typeof value["nodeId"] !== "string") {
    throw new Error(`${label} is invalid`);
  }
  const failureClass = value["failureClass"];
  if (
    failureClass !== undefined &&
    (typeof failureClass !== "string" || !FAILURE_CLASSES.has(failureClass))
  ) {
    throw new Error(`${label} has an invalid failureClass`);
  }
  const cause = snapshotJsonValue(value["cause"], `${label} cause`);
  return Object.freeze(
    failureClass === undefined
      ? { nodeId: value["nodeId"], cause }
      : {
          nodeId: value["nodeId"],
          cause,
          failureClass: failureClass as FailureClass,
        },
  );
}

export function snapshotRunOutcome(value: unknown): RunOutcome {
  if (!isPlainObject(value)) {
    throw new Error("run outcome is invalid");
  }
  switch (value["status"]) {
    case "succeeded":
      if (!Object.hasOwn(value, "output")) {
        throw new Error("succeeded run outcome is missing output");
      }
      return Object.freeze({
        status: "succeeded",
        output: snapshotJsonValue(value["output"], "run output"),
      });

    case "failed":
      return Object.freeze({
        status: "failed",
        failures: snapshotFailures(value["failures"]),
      });

    case "cancelled":
      return Object.freeze({
        status: "cancelled",
        reason: snapshotJsonValue(value["reason"], "cancellation reason"),
        failures: snapshotFailures(value["failures"]),
      });

    default:
      throw new Error("run outcome has an invalid status");
  }
}

export function snapshotRunEvent(
  event: RunEvent,
  seq: number,
  timestampMs: number | null,
): PersistedRunEvent {
  if (
    timestampMs !== null &&
    (!Number.isSafeInteger(timestampMs) || timestampMs < 0)
  ) {
    throw new Error("event timestampMs must be a non-negative safe integer");
  }
  const persisted = { seq, timestampMs } as const;
  switch (event.kind) {
    case "node_ready":
    case "node_started":
    case "node_cancelling":
    case "node_cancelled":
    case "node_reset":
      return Object.freeze({
        kind: event.kind,
        nodeId: event.nodeId,
        ...persisted,
      });

    case "node_phase_changed":
      return Object.freeze({
        kind: event.kind,
        nodeId: event.nodeId,
        phase: event.phase,
        ...persisted,
      });

    case "node_succeeded":
      return Object.freeze({
        kind: event.kind,
        nodeId: event.nodeId,
        output: snapshotJsonValue(event.output, "node output"),
        ...persisted,
      });

    case "node_failed":
      return Object.freeze({
        kind: event.kind,
        nodeId: event.nodeId,
        failure: snapshotNodeFailure(event.failure),
        ...persisted,
      });

    case "node_retry_wait":
      return Object.freeze({
        kind: event.kind,
        nodeId: event.nodeId,
        attempt: event.attempt,
        delayMs: event.delayMs,
        failure: snapshotNodeFailure(event.failure),
        ...persisted,
      });

    case "node_blocked":
      return Object.freeze({
        kind: event.kind,
        nodeId: event.nodeId,
        blockedBy: Object.freeze([...event.blockedBy]),
        ...persisted,
      });

    default: {
      const unhandledEvent: never = event;
      throw new Error(`unhandled run event: ${JSON.stringify(unhandledEvent)}`);
    }
  }
}

function snapshotFailures(value: unknown): readonly NodeFailure[] {
  if (!Array.isArray(value)) {
    throw new Error("run outcome failures must be an array");
  }
  return Object.freeze(
    value.map((failure, index) =>
      snapshotNodeFailure(failure, `run outcome failure ${String(index)}`),
    ),
  );
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const entries = value as readonly JsonValue[];
    return entries.map((entry) => cloneJsonValue(entry));
  }
  const clone: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const [key, entry] of Object.entries(value)) {
    clone[key] = cloneJsonValue(entry);
  }
  return clone;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
