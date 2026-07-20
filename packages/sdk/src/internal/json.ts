import type { JsonValue } from "../graph/types.js";

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Whether a value can be represented as JSON without coercion or data loss.
 * Shared references are allowed; circular references are not.
 */
export function isJsonValue(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value !== "object") {
    return false;
  }

  if (ancestors.has(value)) {
    return false;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, nextAncestors));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && isJsonValue(value[key], nextAncestors),
  );
}
