import { describe, expect, test } from "vitest";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  parseGraph,
} from "../src/index.js";
import type {
  CompiledGraph,
  ExecutorDefinition,
  PersistedRunEvent,
} from "../src/index.js";

function buildGraph(definition: unknown): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error("fixture compile failed");
  return compiled.graph;
}

/** Requires config.value; otherwise its validateConfig throws. */
const strict: ExecutorDefinition = {
  name: "strict",
  validateConfig(config) {
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      !("value" in config)
    ) {
      throw new Error("strict requires config.value");
    }
  },
  execute(context) {
    return { status: "succeeded", output: context.config ?? null };
  },
};

function run(graph: CompiledGraph) {
  return createEngine({
    store: createMemoryStore(),
    registry: createExecutorRegistry([...builtinExecutors, strict]),
  }).run(graph);
}

async function eventKinds(handle: ReturnType<typeof run>): Promise<string[]> {
  const seen: PersistedRunEvent[] = [];
  for await (const event of handle.events) {
    seen.push(event);
  }
  return seen.map((event) => event.kind);
}

describe("executor config validation at preflight", () => {
  test("invalid config fails the run before any node starts", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { bad: { executor: "strict", config: { wrong: true } } },
      finalNode: "bad",
    });
    const handle = run(graph);
    const outcome = await handle.result;
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failures[0]?.nodeId).toBe("bad");
      const cause = outcome.failures[0]?.cause as { code?: string };
      expect(cause.code).toBe("INVALID_CONFIG");
    }
    // Preflight rejection means the node never began executing.
    expect(await eventKinds(handle)).toEqual([]);
  });

  test("valid config runs normally", async () => {
    const graph = buildGraph({
      version: 1,
      nodes: { ok: { executor: "strict", config: { value: 42 } } },
      finalNode: "ok",
    });
    const outcome = await run(graph).result;
    expect(outcome).toEqual({ status: "succeeded", output: { value: 42 } });
  });
});

describe("built-in executors declare validateConfig", () => {
  function validatorFor(name: string): ExecutorDefinition["validateConfig"] {
    const found = builtinExecutors.find((e) => e.name === name);
    return found?.validateConfig;
  }

  test("constant requires a value", () => {
    const validate = validatorFor("constant");
    expect(validate).toBeDefined();
    expect(() => validate?.({ value: 1 })).not.toThrow();
    expect(() => validate?.({})).toThrow();
    expect(() => validate?.(undefined)).toThrow();
  });

  test("passthrough accepts no config", () => {
    const validate = validatorFor("passthrough");
    expect(validate).toBeDefined();
    expect(() => validate?.(undefined)).not.toThrow();
    expect(() => validate?.({ anything: true })).toThrow();
  });

  test("concat rejects a non-string separator", () => {
    const validate = validatorFor("concat");
    expect(validate).toBeDefined();
    expect(() => validate?.(undefined)).not.toThrow();
    expect(() => validate?.({ separator: " " })).not.toThrow();
    expect(() => validate?.({ separator: 5 })).toThrow();
  });
});
