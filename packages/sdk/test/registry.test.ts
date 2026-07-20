import { describe, expect, test } from "vitest";
import { createExecutorRegistry } from "../src/index.js";
import type { ExecutorDefinition } from "../src/index.js";

function def(name: string): ExecutorDefinition {
  return { name, execute: () => ({ status: "succeeded", output: name }) };
}

describe("createExecutorRegistry", () => {
  test("get, has, and names for registered executors", () => {
    const registry = createExecutorRegistry([def("b"), def("a")]);
    expect(registry.has("a")).toBe(true);
    expect(registry.get("b")?.name).toBe("b");
    expect(registry.has("missing")).toBe(false);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.names).toEqual(["b", "a"]);
  });

  test("duplicate names throw", () => {
    expect(() => createExecutorRegistry([def("dup"), def("dup")])).toThrow();
  });

  test("mutating the input array does not affect the registry", () => {
    const defs = [def("a")];
    const registry = createExecutorRegistry(defs);
    defs.push(def("b"));
    expect(registry.has("b")).toBe(false);
    expect(registry.names).toEqual(["a"]);
  });

  test("two registries are independent (no global state)", () => {
    const one = createExecutorRegistry([def("a")]);
    const two = createExecutorRegistry([def("b")]);
    expect(one.has("b")).toBe(false);
    expect(two.has("a")).toBe(false);
  });
});
