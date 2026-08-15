import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "../graph/types.js";
import type { NodePhase } from "../runtime/events.js";
import type { WorkerResult, WorkerSpec } from "./worker-protocol.js";

/** Durable identity for one agent attempt.  It deliberately does not include a
 * process id: a backend session may outlive the engine process supervising it. */
export interface AgentSessionKey {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
}

export interface AgentSession {
  readonly id: string;
  /** Opaque, JSON-safe state the backend needs in order to resume. */
  readonly state: JsonValue;
}

export interface AgentSessionInput {
  readonly key: AgentSessionKey;
  readonly spec: WorkerSpec;
  readonly nodeDir: string;
  readonly worktreeDir: string;
  readonly prompt: string;
  /** Resolved executor sandbox; defaults to workspace-write for compatibility. */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export type AgentSessionEvent =
  | { readonly kind: "output"; readonly text: string }
  | { readonly kind: "phase"; readonly phase: NodePhase }
  | { readonly kind: "result"; readonly result: WorkerResult }
  | { readonly kind: "protocol_error"; readonly error: string };

/**
 * Owns an agent conversation, unlike ExecutionBackend which owns the machine
 * that runs a worker process.  Implementations must make resume idempotent.
 */
export interface AgentSessionBackend {
  readonly name: string;
  start(input: AgentSessionInput): Promise<AgentSession>;
  resume(
    input: AgentSessionInput,
    session: AgentSession,
  ): Promise<AgentSession>;
  steer(session: AgentSession, message: string): Promise<void>;
  interrupt(session: AgentSession): Promise<void>;
  events(session: AgentSession): AsyncIterable<AgentSessionEvent>;
}

export interface AgentSessionStore {
  load(key: AgentSessionKey): Promise<AgentSession | undefined>;
  save(key: AgentSessionKey, session: AgentSession): Promise<void>;
  remove(key: AgentSessionKey): Promise<void>;
}

const SESSION_FILE = "agent-session.json";

/**
 * A durable store rooted outside transient worker directories. Session files
 * are partitioned by the complete attempt identity so a new engine instance
 * can locate the same backend conversation without colliding with a retry.
 */
export function createFileAgentSessionStore(
  baseDir: string,
): AgentSessionStore {
  const pathFor = (key: AgentSessionKey): string =>
    join(
      baseDir,
      safePathPart(key.runId),
      safePathPart(key.nodeId),
      `attempt-${String(key.attempt)}`,
      SESSION_FILE,
    );
  return {
    async load(key) {
      const path = pathFor(key);
      try {
        const value = JSON.parse(await readFile(path, "utf8")) as {
          key?: AgentSessionKey;
          session?: AgentSession;
        };
        if (
          value.key?.runId !== key.runId ||
          value.key.nodeId !== key.nodeId ||
          value.key.attempt !== key.attempt ||
          typeof value.session?.id !== "string"
        )
          return undefined;
        return value.session;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    },
    async save(key, session) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify({ key, session }), "utf8");
      await rename(temporary, path);
    },
    async remove(_key) {
      // Completion is intentionally retained. It is evidence of the backend
      // identity for incident recovery and prevents an engine restart from
      // silently starting a different conversation for the same attempt.
    },
  };
}

function safePathPart(value: string): string {
  // Hex preserves every UTF-8 byte and uses only portable filename bytes.
  // The prefix also makes an empty identifier a non-empty directory name.
  return `utf8-${Buffer.from(value, "utf8").toString("hex")}`;
}

export interface AgentSessionEngineOptions {
  readonly backend: AgentSessionBackend;
  readonly store?: AgentSessionStore;
  readonly onOutput?: (text: string) => void;
  readonly onPhase?: (phase: NodePhase) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

/** Start-or-resume one durable backend session and normalize protocol failures. */
export async function runAgentSession(
  input: AgentSessionInput,
  options: AgentSessionEngineOptions,
): Promise<WorkerResult> {
  const store = options.store ?? createFileAgentSessionStore(input.nodeDir);
  let session = await store.load(input.key);
  try {
    session =
      session === undefined
        ? await options.backend.start(input)
        : await options.backend.resume(input, session);
    await store.save(input.key, session);
    const abort = async (): Promise<void> => {
      await options.backend
        .interrupt(session as AgentSession)
        .catch(() => undefined);
    };
    if (options.signal?.aborted) await abort();
    options.signal?.addEventListener("abort", () => void abort(), {
      once: true,
    });
    for await (const event of options.backend.events(session)) {
      if (event.kind === "output") options.onOutput?.(event.text);
      else if (event.kind === "phase") await options.onPhase?.(event.phase);
      else if (event.kind === "result") return event.result;
      else return protocolFailure(event.error);
    }
    return protocolFailure("agent session ended without a result event");
  } catch (error: unknown) {
    return protocolFailure(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function protocolFailure(error: string): WorkerResult {
  return {
    status: "failed",
    error: `agent backend protocol error: ${error}`,
    failureClass: "transient_infra",
  };
}
