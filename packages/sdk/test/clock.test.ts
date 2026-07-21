import { describe, expect, test } from "vitest";
import { createManualClock, createSystemClock } from "../src/index.js";

/** Flush pending microtasks and one macrotask tick. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createManualClock", () => {
  test("time only moves when the test moves it", () => {
    const clock = createManualClock();
    const start = clock.now();
    clock.advance(500);
    expect(clock.now()).toBe(start + 500);
  });

  test("a wait resolves only once its deadline passes", async () => {
    const clock = createManualClock();
    let resolved = false;
    void clock.wait(100).then(() => {
      resolved = true;
    });

    expect(clock.pending).toBe(1);
    clock.advance(99);
    await settle();
    expect(resolved).toBe(false);

    clock.advance(1);
    await settle();
    expect(resolved).toBe(true);
    expect(clock.pending).toBe(0);
  });

  test("a zero-delay wait still resolves asynchronously", async () => {
    const clock = createManualClock();
    let resolved = false;
    const waited = clock.wait(0).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    clock.advance(0);
    await waited;
    expect(resolved).toBe(true);
  });

  test("waits resolve in deadline order", async () => {
    const clock = createManualClock();
    const order: string[] = [];
    void clock.wait(300).then(() => order.push("late"));
    void clock.wait(100).then(() => order.push("early"));
    void clock.wait(200).then(() => order.push("middle"));

    expect(clock.pending).toBe(3);
    clock.advance(1000);
    await settle();
    expect(order).toEqual(["early", "middle", "late"]);
  });

  test("advanceToNext jumps exactly to the earliest deadline", async () => {
    const clock = createManualClock();
    void clock.wait(250);
    void clock.wait(75);

    expect(clock.advanceToNext()).toBe(75);
    await settle();
    expect(clock.pending).toBe(1);

    expect(clock.advanceToNext()).toBe(175);
    await settle();
    expect(clock.pending).toBe(0);
    expect(clock.advanceToNext()).toBe(0);
  });

  test("an already-aborted signal rejects immediately", async () => {
    const clock = createManualClock();
    const controller = new AbortController();
    controller.abort();
    await expect(clock.wait(100, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(clock.pending).toBe(0);
  });

  test("aborting during a wait rejects and drops the waiter", async () => {
    const clock = createManualClock();
    const controller = new AbortController();
    const waited = clock.wait(100, controller.signal);
    expect(clock.pending).toBe(1);

    controller.abort();
    await expect(waited).rejects.toMatchObject({ name: "AbortError" });
    expect(clock.pending).toBe(0);

    // The abandoned deadline must not resolve anything later.
    clock.advance(1000);
    await settle();
    expect(clock.pending).toBe(0);
  });
});

describe("createSystemClock", () => {
  test("now() tracks real time", () => {
    const clock = createSystemClock();
    const before = Date.now();
    const now = clock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThan(before + 1000);
  });

  test("wait resolves after a real delay", async () => {
    const clock = createSystemClock();
    const before = Date.now();
    await clock.wait(5);
    expect(Date.now()).toBeGreaterThanOrEqual(before + 4);
  });

  test("wait rejects when its signal aborts", async () => {
    const clock = createSystemClock();
    const controller = new AbortController();
    const waited = clock.wait(10_000, controller.signal);
    controller.abort();
    await expect(waited).rejects.toMatchObject({ name: "AbortError" });
  });
});
