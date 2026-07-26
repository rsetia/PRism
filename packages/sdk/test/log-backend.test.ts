import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { LogBackend, LogTarget } from "../src/index.js";
import { createFileLogBackend } from "../src/node/index.js";
import { runLogBackendContract } from "../src/testing/index.js";

const root = mkdtempSync(join(tmpdir(), "prism-logs-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function backend(): LogBackend {
  counter += 1;
  return createFileLogBackend({ baseDir: join(root, `l-${String(counter)}`) });
}

runLogBackendContract("createFileLogBackend", () => Promise.resolve(backend()));

const target: LogTarget = { runId: "r", nodeId: "n", attempt: 1 };

describe("createFileLogBackend filesystem safety", () => {
  test("rejects identifiers too long for a portable path component", async () => {
    const b = backend();
    await expect(
      b.openWriter({ ...target, nodeId: "x".repeat(200) }),
    ).rejects.toThrow("too long");
  });

  test("rejects identifiers that cannot round-trip through UTF-8", async () => {
    const b = backend();
    await expect(b.openWriter({ ...target, nodeId: "\ud800" })).rejects.toThrow(
      "well-formed Unicode",
    );
  });
});
