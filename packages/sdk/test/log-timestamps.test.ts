import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { LogTarget } from "../src/index.js";
import {
  createFileLogBackend,
  createLineStamper,
  withLineTimestamps,
} from "../src/node/index.js";

const root = mkdtempSync(join(tmpdir(), "prism-log-stamps-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 9, 3, 18, 20, 47, 123);
const S0 = "2026-10-03T18:20:47.123Z ";
const S1 = "2026-10-03T18:20:48.123Z ";

/** A clock that advances one second per call. */
function ticking(): () => number {
  let calls = 0;
  return () => T0 + 1_000 * calls++;
}

describe("createLineStamper", () => {
  test("prefixes every line in one chunk", () => {
    const stamp = createLineStamper(() => T0);
    expect(stamp("one\ntwo\n")).toBe(`${S0}one\n${S0}two\n`);
  });

  test("continues a line split across chunks without a second prefix", () => {
    const stamp = createLineStamper(ticking());
    expect(stamp("hel")).toBe(`${S0}hel`);
    expect(stamp("lo\nwor")).toBe(`lo\n${S1}wor`);
  });

  test("stamps the next chunk after a chunk that ends a line", () => {
    const stamp = createLineStamper(ticking());
    expect(stamp("done\n")).toBe(`${S0}done\n`);
    expect(stamp("next")).toBe(`${S1}next`);
  });

  test("leaves a trailing partial line open and keeps blank lines", () => {
    const stamp = createLineStamper(() => T0);
    expect(stamp("a\n\nb")).toBe(`${S0}a\n${S0}\n${S0}b`);
    expect(stamp("")).toBe("");
    expect(stamp("\n")).toBe("\n");
  });
});

describe("withLineTimestamps", () => {
  const target: LogTarget = { runId: "r", nodeId: "n", attempt: 1 };

  test("stores stamped text and reads it back unchanged", async () => {
    const backend = withLineTimestamps(
      createFileLogBackend({ baseDir: join(root, "stamped") }),
      { now: () => T0 },
    );
    const writer = await backend.openWriter(target);
    await writer.write("worker ");
    await writer.write("output\nsecond line\n");
    await writer.close();
    let text = "";
    for await (const chunk of backend.read(target)) text += chunk;
    expect(text).toBe(`${S0}worker output\n${S0}second line\n`);
    await backend.close?.();
  });

  test("starts each reopened log generation at a line start", async () => {
    const backend = withLineTimestamps(
      createFileLogBackend({ baseDir: join(root, "reopened") }),
      { now: () => T0 },
    );
    const first = await backend.openWriter(target);
    await first.write("partial");
    await first.close();
    const second = await backend.openWriter(target);
    await second.write("fresh\n");
    await second.close();
    let text = "";
    for await (const chunk of backend.read(target)) text += chunk;
    expect(text).toBe(`${S0}fresh\n`);
  });
});
