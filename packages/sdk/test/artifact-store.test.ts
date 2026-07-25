import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { createLocalArtifactStore } from "../src/node/index.js";
import type { ArtifactStore, PutArtifactInput } from "../src/node/index.js";

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

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("createLocalArtifactStore", () => {
  test("put then get round-trips the bytes", async () => {
    const s = store();
    const ref = await s.put(put());
    expect(ref.filename).toBe("output.txt");
    expect(ref.size).toBe(5);
    expect(ref.uri.length).toBeGreaterThan(0);
    expect(decode(await s.get(ref.uri))).toBe("hello");
  });

  test("preserves an optional content type", async () => {
    const s = store();
    const ref = await s.put(
      put({ filename: "data.json", contentType: "application/json" }),
    );
    expect(ref.contentType).toBe("application/json");
  });

  test("list returns a node's artifacts across attempts", async () => {
    const s = store();
    await s.put(put({ attempt: 1, filename: "a.txt" }));
    await s.put(put({ attempt: 2, filename: "b.txt" }));
    const refs = await s.list({ runId: "r", nodeId: "n" });
    expect(refs.map((r) => r.filename).sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("list for an unknown node is empty, not an error", async () => {
    const s = store();
    expect(await s.list({ runId: "r", nodeId: "ghost" })).toEqual([]);
  });

  test("get rejects an unknown uri", async () => {
    const s = store();
    const ref = await s.put(put());
    await expect(s.get(`${ref.uri}.missing`)).rejects.toThrow();
  });

  test("get refuses a uri outside the store's base dir", async () => {
    const s = store();
    const outside = pathToFileURL(join(root, "..", "escape.txt")).href;
    await expect(s.get(outside)).rejects.toThrow();
  });
});
