import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ArtifactStore, PutArtifactInput } from "../runtime/ports.js";

/**
 * Creates a fresh, empty artifact store for one contract test.
 * Asynchronous factories are supported for remote clients and test buckets.
 */
export type ArtifactStoreFactory = () => ArtifactStore | Promise<ArtifactStore>;

/**
 * Registers Prism's backend-neutral ArtifactStore conformance suite with
 * Vitest. Call this at module scope in a test file.
 *
 * `makeStore` is called before each test, and the returned store is closed
 * afterward when it exposes `close`.
 */
export function runArtifactStoreContract(
  label: string,
  makeStore: ArtifactStoreFactory,
): void {
  describe(`ArtifactStore contract: ${label}`, () => {
    let store: ArtifactStore | undefined;

    beforeEach(async () => {
      store = await makeStore();
    });

    function open(): ArtifactStore {
      if (store === undefined) {
        throw new Error("ArtifactStore factory did not complete");
      }
      return store;
    }

    afterEach(async () => {
      const opened = store;
      store = undefined;
      await opened?.close?.();
    });

    test("put then get round-trips bytes and metadata", async () => {
      const s = open();
      const ref = await s.put(put());

      expect(ref.filename).toBe("output.txt");
      expect(ref.size).toBe(5);
      expect(ref.uri.length).toBeGreaterThan(0);
      expect(ref).not.toHaveProperty("contentType");
      expect([...(await s.get(ref.uri))]).toEqual([...bytes("hello")]);
    });

    test("preserves optional content type in put and list results", async () => {
      const s = open();
      const ref = await s.put(
        put({
          filename: "data.json",
          data: bytes("{}"),
          contentType: "application/json",
        }),
      );

      expect(ref.contentType).toBe("application/json");
      expect(await s.list({ runId: "r", nodeId: "n" })).toMatchObject([
        {
          uri: ref.uri,
          filename: "data.json",
          size: 2,
          contentType: "application/json",
        },
      ]);
    });

    test("list spans attempts and isolates run and node namespaces", async () => {
      const s = open();
      await s.put(put({ filename: "a.txt" }));
      await s.put(put({ attempt: 2, filename: "b.txt" }));
      await s.put(put({ nodeId: "other", filename: "other-node.txt" }));
      await s.put(put({ runId: "other", filename: "other-run.txt" }));

      const refs = await s.list({ runId: "r", nodeId: "n" });
      expect(refs.map((ref) => ref.filename).sort()).toEqual([
        "a.txt",
        "b.txt",
      ]);
    });

    test("the same filename in different attempts remains distinct", async () => {
      const s = open();
      const first = await s.put(put({ attempt: 1, data: bytes("first") }));
      const second = await s.put(put({ attempt: 2, data: bytes("second") }));

      expect(first.uri).not.toBe(second.uri);
      expect(decode(await s.get(first.uri))).toBe("first");
      expect(decode(await s.get(second.uri))).toBe("second");
      expect(await s.list({ runId: "r", nodeId: "n" })).toHaveLength(2);
    });

    test("distinct logical run and node identifiers never alias", async () => {
      const s = open();
      const first = await s.put(
        put({
          runId: "run/a",
          nodeId: "node:one",
          data: bytes("first"),
        }),
      );
      const second = await s.put(
        put({
          runId: "run?a",
          nodeId: "node?one",
          data: bytes("second"),
        }),
      );

      expect(first.uri).not.toBe(second.uri);
      expect(decode(await s.get(first.uri))).toBe("first");
      expect(decode(await s.get(second.uri))).toBe("second");
      expect(
        await s.list({ runId: "run/a", nodeId: "node:one" }),
      ).toMatchObject([{ filename: "output.txt" }]);
      expect(
        await s.list({ runId: "run?a", nodeId: "node?one" }),
      ).toMatchObject([{ filename: "output.txt" }]);
    });

    test("distinct filenames within one attempt never alias", async () => {
      const s = open();
      const first = await s.put(
        put({ filename: "report/a.txt", data: bytes("first") }),
      );
      const second = await s.put(
        put({ filename: "report?a.txt", data: bytes("second") }),
      );

      expect(first.uri).not.toBe(second.uri);
      expect(decode(await s.get(first.uri))).toBe("first");
      expect(decode(await s.get(second.uri))).toBe("second");
      expect(
        (await s.list({ runId: "r", nodeId: "n" }))
          .map((ref) => ref.filename)
          .sort(),
      ).toEqual(["report/a.txt", "report?a.txt"]);
    });

    test("snapshots input bytes and returns fresh bytes from get", async () => {
      const s = open();
      const data = new Uint8Array([1, 2, 3]);
      const ref = await s.put(put({ data }));
      data[0] = 9;

      const firstRead = await s.get(ref.uri);
      expect([...firstRead]).toEqual([1, 2, 3]);
      firstRead[1] = 9;
      expect([...(await s.get(ref.uri))]).toEqual([1, 2, 3]);
    });

    test("accepts Unicode and traversal-like logical names without aliasing", async () => {
      const s = open();
      const ref = await s.put(
        put({
          runId: "../製品",
          nodeId: "../../é",
          filename: "../../../résultat.json",
        }),
      );

      expect(ref.filename).toBe("../../../résultat.json");
      expect(decode(await s.get(ref.uri))).toBe("hello");
      expect(
        await s.list({ runId: "../製品", nodeId: "../../é" }),
      ).toMatchObject([{ filename: "../../../résultat.json" }]);
    });

    test("rejects attempts that are not positive integers", async () => {
      const s = open();
      await expect(s.put(put({ attempt: 0 }))).rejects.toThrow();
      await expect(s.put(put({ attempt: 1.5 }))).rejects.toThrow();
    });

    test("list for an unknown node is empty", async () => {
      expect(await open().list({ runId: "r", nodeId: "ghost" })).toEqual([]);
    });

    test("get rejects an unknown URI", async () => {
      const s = open();
      const ref = await s.put(put());
      await expect(s.get(`${ref.uri}.missing`)).rejects.toThrow();
    });
  });
}

function put(overrides: Partial<PutArtifactInput> = {}): PutArtifactInput {
  return {
    runId: "r",
    nodeId: "n",
    attempt: 1,
    filename: "output.txt",
    data: bytes("hello"),
    ...overrides,
  };
}

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);
