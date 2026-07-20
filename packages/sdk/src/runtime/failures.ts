import type { JsonValue } from "../graph/types.js";
import { isJsonValue } from "../internal/json.js";

/**
 * Normalize anything an executor threw (or rejected with) into
 * persistable failure data. Never assume a caught value is an `Error`.
 *
 * Rules (plan §4, decided):
 * - `Error` instances  -> { name, message }
 * - JSON-safe values   -> as-is (strings, finite numbers, booleans,
 *                         null, plain acyclic objects/arrays — same
 *                         definition as parseGraph's config check)
 * - everything else    -> String(value) fallback
 */
export function normalizeThrownCause(thrown: unknown): JsonValue {
  try {
    if (thrown instanceof Error) {
      return { name: thrown.name, message: thrown.message };
    }
  } catch {
    // Hostile proxies and accessor-backed Error fields can throw while
    // inspected. Continue through the progressively safer fallbacks.
  }

  try {
    if (isJsonValue(thrown)) {
      return thrown;
    }
  } catch {
    // A value with throwing proxy traps is not usable as JSON failure data.
  }

  try {
    // This fallback is deliberately JavaScript's general coercion: thrown
    // values need not have a more useful or safer representation.
    return String(thrown);
  } catch {
    return "unstringifiable thrown value";
  }
}
