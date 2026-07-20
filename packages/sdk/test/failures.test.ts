import { describe, expect, test } from "vitest";
import { normalizeThrownCause } from "../src/index.js";

describe("normalizeThrownCause", () => {
  test("Error instances become { name, message }", () => {
    expect(normalizeThrownCause(new RangeError("out of range"))).toEqual({
      name: "RangeError",
      message: "out of range",
    });
  });

  test("JSON-safe thrown values pass through as-is", () => {
    expect(normalizeThrownCause("boom")).toBe("boom");
    expect(normalizeThrownCause(42)).toBe(42);
    expect(normalizeThrownCause(null)).toBe(null);
    expect(normalizeThrownCause({ code: "X", hint: [1, 2] })).toEqual({
      code: "X",
      hint: [1, 2],
    });
  });

  test("never assumes Error: non-JSON values fall back to String(...)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(typeof normalizeThrownCause(cyclic)).toBe("string");
    expect(normalizeThrownCause(undefined)).toBe("undefined");
    expect(typeof normalizeThrownCause(() => 1)).toBe("string");
    expect(typeof normalizeThrownCause(Number.NaN)).toBe("string");
  });

  test("cannot be broken by a thrown proxy with hostile traps", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("no prototype access");
        },
        get() {
          throw new Error("no property access");
        },
      },
    );

    expect(() => normalizeThrownCause(hostile)).not.toThrow();
    expect(typeof normalizeThrownCause(hostile)).toBe("string");
  });
});
