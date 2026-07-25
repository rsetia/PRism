import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createFileLogBackend } from "../src/node/index.js";
import type { LogBackend, LogTarget } from "../src/node/index.js";

const root = mkdtempSync(join(tmpdir(), "prism-logs-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function backend(): LogBackend {
  counter += 1;
  return createFileLogBackend({ baseDir: join(root, `l-${String(counter)}`) });
}

const target: LogTarget = { runId: "r", nodeId: "n", attempt: 1 };

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of iterable) {
    text += chunk;
  }
  return text;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createFileLogBackend", () => {
  test("writes then reads back the full log", async () => {
    const b = backend();
    const writer = await b.openWriter(target);
    await writer.write("line one\n");
    await writer.write("line two\n");
    await writer.close();
    expect(await collect(b.read(target))).toBe("line one\nline two\n");
  });

  test("a non-follow read of a missing log is empty", async () => {
    const b = backend();
    expect(await collect(b.read(target))).toBe("");
  });

  test("follow yields content as it is written, ending on close", async () => {
    const b = backend();
    const writer = await b.openWriter(target);
    const seen: string[] = [];
    const done = (async () => {
      for await (const chunk of b.read(target, { follow: true })) {
        seen.push(chunk);
      }
    })();

    await writer.write("a");
    await settle();
    await writer.write("b");
    await writer.close();
    await done;
    expect(seen.join("")).toBe("ab");
  });

  test("an aborted follow ends cleanly", async () => {
    const b = backend();
    const writer = await b.openWriter(target);
    await writer.write("partial");
    const controller = new AbortController();
    const read = collect(
      b.read(target, { follow: true, signal: controller.signal }),
    );
    await settle();
    controller.abort();
    await expect(read).resolves.toContain("partial");
    await writer.close();
  });

  test("writing after close rejects", async () => {
    const b = backend();
    const writer = await b.openWriter(target);
    await writer.close();
    await expect(writer.write("late")).rejects.toThrow();
  });
});
