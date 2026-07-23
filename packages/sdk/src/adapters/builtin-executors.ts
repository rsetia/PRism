import type { JsonValue } from "../graph/types.js";
import { isPlainObject } from "../internal/json.js";
import type { ExecutorDefinition } from "../runtime/ports.js";

function failed(code: string): {
  readonly status: "failed";
  readonly cause: JsonValue;
} {
  return { status: "failed", cause: { code } };
}

function freezeExecutor(executor: ExecutorDefinition): ExecutorDefinition {
  return Object.freeze(executor);
}

const constant = freezeExecutor({
  name: "constant",
  validateConfig(config) {
    if (!isPlainObject(config) || !Object.hasOwn(config, "value")) {
      throw new Error("constant requires config.value");
    }
  },
  execute(context) {
    if (
      !isPlainObject(context.config) ||
      !Object.hasOwn(context.config, "value")
    ) {
      return failed("INVALID_CONSTANT_CONFIG");
    }

    return { status: "succeeded", output: context.config["value"] };
  },
});

const passthrough = freezeExecutor({
  name: "passthrough",
  validateConfig(config) {
    if (config !== undefined) {
      throw new Error("passthrough does not accept config");
    }
  },
  execute(context) {
    if (context.inputs.length !== 1) {
      return failed("INVALID_PASSTHROUGH_INPUTS");
    }

    return { status: "succeeded", output: context.inputs[0] };
  },
});

const concat = freezeExecutor({
  name: "concat",
  validateConfig(config) {
    if (config === undefined) {
      return;
    }
    if (
      !isPlainObject(config) ||
      (Object.hasOwn(config, "separator") &&
        typeof config["separator"] !== "string")
    ) {
      throw new Error("concat config.separator must be a string");
    }
  },
  execute(context) {
    const inputs: string[] = [];
    for (const input of context.inputs) {
      if (typeof input !== "string") {
        return failed("INVALID_CONCAT_INPUTS");
      }
      inputs.push(input);
    }

    let separator = "";
    if (context.config !== undefined) {
      if (!isPlainObject(context.config)) {
        return failed("INVALID_CONCAT_CONFIG");
      }

      if (Object.hasOwn(context.config, "separator")) {
        const configuredSeparator = context.config["separator"];
        if (typeof configuredSeparator !== "string") {
          return failed("INVALID_CONCAT_CONFIG");
        }
        separator = configuredSeparator;
      }
    }

    return { status: "succeeded", output: inputs.join(separator) };
  },
});

const fail = freezeExecutor({
  name: "fail",
  validateConfig() {},
  execute(context) {
    return {
      status: "failed",
      cause: context.config ?? null,
    };
  },
});

function freezeExecutors(
  executors: readonly ExecutorDefinition[],
): readonly ExecutorDefinition[] {
  return Object.freeze([...executors]);
}

/**
 * The four built-ins (plan §4, step 4) — the minimum set that
 * demonstrates composition and failure. Specs:
 *
 * - constant:    ignores inputs; output = config.value. Failed outcome
 *                if config is missing or has no "value" property.
 * - passthrough: exactly one input -> that input. Failed otherwise.
 * - concat:      all inputs must be strings -> joined with
 *                config.separator (default ""). Failed otherwise.
 * - fail:        always a failed outcome; cause = config ?? null.
 *                Exists so failure paths get first-class fixtures.
 *
 * All failures are returned outcomes ({ status: "failed", cause }),
 * never throws — these four are also the reference examples for
 * "failures are data".
 */
export const builtinExecutors: readonly ExecutorDefinition[] = freezeExecutors([
  constant,
  passthrough,
  concat,
  fail,
]);
