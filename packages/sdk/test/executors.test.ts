import { describe, expect, test } from "vitest";
import { builtinExecutors, createExecutorRegistry } from "../src/index.js";
import type { ExecutionContext, NodeExecutionOutcome } from "../src/index.js";

function ctx(partial?: Partial<ExecutionContext>): ExecutionContext {
  return {
    nodeId: "n",
    inputs: [],
    signal: new AbortController().signal,
    ...partial,
  };
}

async function run(
  name: string,
  context: ExecutionContext,
): Promise<NodeExecutionOutcome> {
  const definition = builtinExecutors.find((e) => e.name === name);
  if (definition === undefined) {
    throw new Error(`no builtin named "${name}"`);
  }
  return definition.execute(context);
}

describe("builtin executors", () => {
  test("registry accepts the builtin set", () => {
    const registry = createExecutorRegistry(builtinExecutors);
    expect(registry.names).toEqual([
      "constant",
      "passthrough",
      "concat",
      "fail",
    ]);
  });

  test("constant returns config.value", async () => {
    const outcome = await run("constant", ctx({ config: { value: "hello" } }));
    expect(outcome).toEqual({ status: "succeeded", output: "hello" });
  });

  test("constant fails as data without a value config", async () => {
    for (const config of [undefined, null, {}, "hello"]) {
      const outcome = await run(
        "constant",
        config === undefined ? ctx() : ctx({ config }),
      );
      expect(outcome.status).toBe("failed");
    }
  });

  test("passthrough returns its single input", async () => {
    const outcome = await run("passthrough", ctx({ inputs: [42] }));
    expect(outcome).toEqual({ status: "succeeded", output: 42 });
  });

  test("passthrough fails as data without exactly one input", async () => {
    for (const inputs of [[], ["a", "b"]]) {
      const outcome = await run("passthrough", ctx({ inputs }));
      expect(outcome.status).toBe("failed");
    }
  });

  test("concat joins string inputs with the configured separator", async () => {
    const spaced = await run(
      "concat",
      ctx({ inputs: ["a", "b"], config: { separator: " " } }),
    );
    expect(spaced).toEqual({ status: "succeeded", output: "a b" });
    const bare = await run("concat", ctx({ inputs: ["x", "y"] }));
    expect(bare).toEqual({ status: "succeeded", output: "xy" });
  });

  test("concat fails as data on non-string inputs", async () => {
    const outcome = await run("concat", ctx({ inputs: ["a", 1] }));
    expect(outcome.status).toBe("failed");
  });

  test("fail always fails, with config as the cause", async () => {
    const withConfig = await run("fail", ctx({ config: { reason: "boom" } }));
    expect(withConfig).toEqual({
      status: "failed",
      cause: { reason: "boom" },
    });
    const bare = await run("fail", ctx());
    expect(bare).toEqual({ status: "failed", cause: null });
  });
});
