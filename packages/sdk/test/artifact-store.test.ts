import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

describe("createLocalArtifactStore durable metadata", () => {
  test("content type survives store reconstruction", async () => {
    const baseDir = join(root, "reconstructed");
    const first = createLocalArtifactStore({ baseDir });
    await first.put(
      put({ filename: "data.json", contentType: "application/json" }),
    );

    const reopened = createLocalArtifactStore({ baseDir });
    expect(await reopened.list({ runId: "r", nodeId: "n" })).toMatchObject([
      { filename: "data.json", contentType: "application/json" },
    ]);
  });

  test("missing artifact files do not leave phantom metadata", async () => {
    const baseDir = join(root, "missing");
    const first = createLocalArtifactStore({ baseDir });
    const ref = await first.put(put({ contentType: "text/plain" }));
    rmSync(fileURLToPath(ref.uri));

    const reopened = createLocalArtifactStore({ baseDir });
    expect(await reopened.list({ runId: "r", nodeId: "n" })).toEqual([]);
  });

  test("duplicate names keep one current metadata record", async () => {
    const baseDir = join(root, "duplicate");
    const first = createLocalArtifactStore({ baseDir });
    const original = await first.put(
      put({ contentType: "text/plain", data: new TextEncoder().encode("old") }),
    );
    await first.put(
      put({
        contentType: "application/json",
        data: new TextEncoder().encode("{}"),
      }),
    );

    const reopened = createLocalArtifactStore({ baseDir });
    expect(await reopened.list({ runId: "r", nodeId: "n" })).toMatchObject([
      { filename: "output.txt", size: 2, contentType: "application/json" },
    ]);
    expect(fileURLToPath(original.uri)).toContain(baseDir);
  });

  test("artifacts created before metadata sidecars remain readable", async () => {
    const baseDir = join(root, "legacy");
    const first = createLocalArtifactStore({ baseDir });
    const ref = await first.put(put({ contentType: "text/plain" }));
    rmSync(join(dirname(fileURLToPath(ref.uri)), ".prism-artifacts-v1.json"));

    const reopened = createLocalArtifactStore({ baseDir });
    expect(await reopened.list({ runId: "r", nodeId: "n" })).toEqual([
      {
        uri: ref.uri,
        filename: "output.txt",
        size: 5,
      },
    ]);
    expect(new TextDecoder().decode(await reopened.get(ref.uri))).toBe("hello");
  });
});
