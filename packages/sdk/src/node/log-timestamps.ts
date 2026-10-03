import type { LogBackend, LogTarget, LogWriter } from "../runtime/ports.js";

export interface LineTimestampOptions {
  /** Clock for the prefix. Default Date.now. */
  readonly now?: () => number;
}

/**
 * Decorate a LogBackend so every written line starts with an ISO-8601 UTC
 * timestamp and a space. Worker output arrives in arbitrary fragments, so
 * the prefix is stamped when a line's first character is written, not when
 * the line completes; a fragment that ends mid-line leaves the next one to
 * continue it unprefixed. Reads pass through unchanged: the stored text is
 * the stamped text.
 *
 * Without timestamps a long gap in a worker log cannot be told apart from
 * a host that slept, which is exactly the question a slow run raises.
 */
export function withLineTimestamps(
  backend: LogBackend,
  options: LineTimestampOptions = {},
): LogBackend {
  const now = options.now ?? Date.now;
  return Object.freeze({
    async openWriter(target: LogTarget): Promise<LogWriter> {
      const writer = await backend.openWriter(target);
      const stamp = createLineStamper(now);
      return Object.freeze({
        write: (chunk: string) => writer.write(stamp(chunk)),
        close: () => writer.close(),
      });
    },
    read: backend.read.bind(backend),
    ...(backend.close === undefined
      ? {}
      : { close: backend.close.bind(backend) }),
  });
}

/**
 * Return a stateful function that prefixes each line start in a stream of
 * text fragments. Exported for reuse by callers that write logs directly.
 */
export function createLineStamper(
  now: () => number = Date.now,
): (chunk: string) => string {
  let atLineStart = true;
  return (chunk: string): string => {
    if (chunk.length === 0) return chunk;
    const prefix = `${new Date(now()).toISOString()} `;
    let output = "";
    let index = 0;
    while (index < chunk.length) {
      if (atLineStart) output += prefix;
      const newline = chunk.indexOf("\n", index);
      if (newline === -1) {
        output += chunk.slice(index);
        atLineStart = false;
        break;
      }
      output += chunk.slice(index, newline + 1);
      index = newline + 1;
      atLineStart = true;
    }
    return output;
  };
}
