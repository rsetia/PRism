import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import type { ArtifactStore, PutArtifactInput } from "../src/index.js";
import { createLocalArtifactStore } from "../src/node/index.js";
import { runArtifactStoreContract } from "../src/testing/index.js";

const root = mkdtempSync(join(tmpdir(), "prism-artifacts-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function store(): ArtifactStore {
  counter += 1;
  return createLocalArtifactStore({
    baseDir: join(root, `s-${String(counter)}`),
  });
}

runArtifactStoreContract("createLocalArtifactStore", () =>
  Promise.resolve(store()),
);

function put(overrides: Partial<PutArtifactInput> = {}): PutArtifactInput {
  return {
    runId: "r",
    nodeId: "n",
    attempt: 1,
    filename: "output.txt",
    data: new TextEncoder().encode("hello"),
    ...overrides,
  };
}

describe("createLocalArtifactStore filesystem safety", () => {
  test("rejects identifiers too long for a portable path component", async () => {
    const s = store();
    await expect(s.put(put({ runId: "x".repeat(200) }))).rejects.toThrow(
      "too long",
    );
  });

  test("rejects strings that cannot round-trip through UTF-8", async () => {
    const s = store();
    await expect(s.put(put({ filename: "\ud800" }))).rejects.toThrow(
      "well-formed Unicode",
    );
  });

  test("get refuses a URI outside the store's base directory", async () => {
    const s = store();
    const outside = pathToFileURL(join(root, "..", "escape.txt")).href;
    await expect(s.get(outside)).rejects.toThrow();
  });
});
