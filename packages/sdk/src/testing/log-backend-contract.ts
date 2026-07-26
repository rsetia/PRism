import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { LogBackend, LogTarget, LogWriter } from "../runtime/ports.js";

/**
 * Creates a fresh, empty log backend for one contract test. Asynchronous
 * factories are supported for remote clients and test namespaces.
 */
export type LogBackendFactory = () => LogBackend | Promise<LogBackend>;

/**
 * Registers Prism's backend-neutral LogBackend conformance suite with Vitest.
 * Call this at module scope in a test file.
 *
 * `makeBackend` is called before each test. Open writers and the backend's
 * optional `close` method are closed afterward.
 */
export function runLogBackendContract(
  label: string,
  makeBackend: LogBackendFactory,
): void {
  describe(`LogBackend contract: ${label}`, () => {
    let backend: LogBackend | undefined;
    const writers = new Set<LogWriter>();

    beforeEach(async () => {
      backend = await makeBackend();
    });

    function open(): LogBackend {
      if (backend === undefined) {
        throw new Error("LogBackend factory did not complete");
      }
      return backend;
    }

    async function openWriter(target: LogTarget = TARGET): Promise<LogWriter> {
      const writer = await open().openWriter(target);
      writers.add(writer);
      return writer;
    }

    afterEach(async () => {
      const opened = backend;
      backend = undefined;
      const pendingWriters = [...writers];
      writers.clear();
      await Promise.allSettled(pendingWriters.map((writer) => writer.close()));
      await opened?.close?.();
    });

    test("writes then reads the complete log", async () => {
      const writer = await openWriter();
      await writer.write("line one\n");
      await writer.write("line two\n");
      await writer.close();

      expect(await collect(open().read(TARGET))).toBe("line one\nline two\n");
    });

    test("serializes concurrent writes in invocation order", async () => {
      const writer = await openWriter();
      await Promise.all([
        writer.write("first"),
        writer.write("-second"),
        writer.write("-third"),
      ]);
      await writer.close();

      expect(await collect(open().read(TARGET))).toBe("first-second-third");
    });

    test("a non-follow read returns current text without waiting for close", async () => {
      const writer = await openWriter();
      await writer.write("partial");

      expect(await collect(open().read(TARGET))).toBe("partial");
      await writer.close();
    });

    test("a non-follow read of a missing log is empty", async () => {
      expect(await collect(open().read(TARGET))).toBe("");
    });

    test("distinct logical target identifiers never alias", async () => {
      const slash: LogTarget = {
        runId: "run/a",
        nodeId: "../worker:one",
        attempt: 1,
      };
      const question: LogTarget = {
        runId: "run?a",
        nodeId: "..?worker?one",
        attempt: 1,
      };
      const slashWriter = await openWriter(slash);
      const questionWriter = await openWriter(question);
      await slashWriter.write("slash");
      await questionWriter.write("question");
      await Promise.all([slashWriter.close(), questionWriter.close()]);

      expect(await collect(open().read(slash))).toBe("slash");
      expect(await collect(open().read(question))).toBe("question");
    });

    test("preserves case, Unicode, and attempt identities", async () => {
      const upper: LogTarget = { runId: "Run", nodeId: "é", attempt: 1 };
      const lower: LogTarget = { runId: "run", nodeId: "?", attempt: 1 };
      const retry: LogTarget = { runId: "Run", nodeId: "é", attempt: 2 };
      const upperWriter = await openWriter(upper);
      const lowerWriter = await openWriter(lower);
      const retryWriter = await openWriter(retry);
      await upperWriter.write("upper");
      await lowerWriter.write("lower");
      await retryWriter.write("retry");
      await Promise.all([
        upperWriter.close(),
        lowerWriter.close(),
        retryWriter.close(),
      ]);

      expect(await collect(open().read(upper))).toBe("upper");
      expect(await collect(open().read(lower))).toBe("lower");
      expect(await collect(open().read(retry))).toBe("retry");
    });

    test("rejects attempts that are not positive integers", async () => {
      await expect(openWriter({ ...TARGET, attempt: 0 })).rejects.toThrow();
      await expect(openWriter({ ...TARGET, attempt: 1.5 })).rejects.toThrow();
    });

    test("allows only one open writer for a target", async () => {
      const writer = await openWriter();
      await expect(openWriter()).rejects.toThrow();
      await writer.close();
    });

    test("writer close is idempotent and later writes reject", async () => {
      const writer = await openWriter();
      await writer.write("done");
      await Promise.all([writer.close(), writer.close()]);
      await expect(writer.write("late")).rejects.toThrow();
      expect(await collect(open().read(TARGET))).toBe("done");
    });

    test("follow can start before the writer and ends after close", async () => {
      const iterator = open()
        .read(TARGET, { follow: true })
        [Symbol.asyncIterator]();
      const firstChunk = iterator.next();
      const writer = await openWriter();
      await writer.write("x");

      await expect(firstChunk).resolves.toMatchObject({
        done: false,
        value: "x",
      });
      const end = iterator.next();
      await writer.close();
      await expect(end).resolves.toMatchObject({ done: true });
    });

    test("follow yields existing and subsequently appended text", async () => {
      const writer = await openWriter();
      await writer.write("b");
      const iterator = open()
        .read(TARGET, { follow: true })
        [Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: "b",
      });
      const nextChunk = iterator.next();
      await writer.write("a");
      await expect(nextChunk).resolves.toMatchObject({
        done: false,
        value: "a",
      });
      const end = iterator.next();
      await writer.close();
      await expect(end).resolves.toMatchObject({ done: true });
    });

    test("multiple followers own independent cursors", async () => {
      const first = open()
        .read(TARGET, { follow: true })
        [Symbol.asyncIterator]();
      const second = open()
        .read(TARGET, { follow: true })
        [Symbol.asyncIterator]();
      const firstChunk = first.next();
      const secondChunk = second.next();
      const writer = await openWriter();
      await writer.write("s");

      await expect(firstChunk).resolves.toMatchObject({
        done: false,
        value: "s",
      });
      await expect(secondChunk).resolves.toMatchObject({
        done: false,
        value: "s",
      });
      const firstEnd = first.next();
      const secondEnd = second.next();
      await writer.close();
      await expect(firstEnd).resolves.toMatchObject({ done: true });
      await expect(secondEnd).resolves.toMatchObject({ done: true });
    });

    test("aborting a follow ends iteration without an error", async () => {
      const controller = new AbortController();
      const iterator = open()
        .read(TARGET, { follow: true, signal: controller.signal })
        [Symbol.asyncIterator]();
      const pending = iterator.next();
      controller.abort();

      await expect(pending).resolves.toMatchObject({ done: true });
    });

    test("round-trips text larger than one typical read buffer", async () => {
      const text = `${"x".repeat(65_535)}🙂tail`;
      const writer = await openWriter();
      await writer.write(text);
      await writer.close();

      expect(await collect(open().read(TARGET))).toBe(text);
    });
  });
}

const TARGET: LogTarget = { runId: "r", nodeId: "n", attempt: 1 };

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of iterable) {
    text += chunk;
  }
  return text;
}
