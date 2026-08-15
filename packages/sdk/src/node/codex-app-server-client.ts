import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { JsonValue } from "../graph/types.js";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionInput,
} from "./agent-session-backend.js";
import type { CodexAppServerClient } from "./codex-app-server-backend.js";
import { parseWorkerResult, WORKER_RESULT_FILE } from "./worker-protocol.js";
import { join } from "node:path";

export interface CodexAppServerStdioClientOptions {
  /** Codex executable. Default "codex". */
  readonly command?: string;
  /** Arguments inserted before the `app-server` subcommand. */
  readonly commandArgs?: readonly string[];
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface RpcResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
}

interface RpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface ActiveTurn {
  readonly input: AgentSessionInput;
  readonly events: EventQueue;
  turnId: string;
}

class EventQueue {
  readonly values: AgentSessionEvent[] = [];
  readonly waiters: Array<(value: IteratorResult<AgentSessionEvent>) => void> =
    [];
  done = false;

  push(event: AgentSessionEvent): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(event);
    else waiter({ done: false, value: event });
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ done: true, value: undefined });
  }

  async next(): Promise<IteratorResult<AgentSessionEvent>> {
    const value = this.values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.done) return { done: true, value: undefined };
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * A local stdio transport for `codex app-server`. The transport is initialized
 * lazily, uses newline-delimited JSON-RPC, and keeps thread ids in Prism's
 * durable AgentSessionStore so a later CLI process can call `thread/resume`.
 */
export function createCodexAppServerStdioClient(
  options: CodexAppServerStdioClientOptions = {},
): CodexAppServerClient {
  let child: ChildProcessWithoutNullStreams | undefined;
  let lineReader: ReturnType<typeof createInterface> | undefined;
  let initialization: Promise<void> | undefined;
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  const turns = new Map<string, ActiveTurn>();

  const send = (message: unknown): void => {
    if (child === undefined || child.stdin.destroyed) {
      throw new Error("Codex App Server transport is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = async (method: string, params: unknown): Promise<unknown> => {
    await ensureInitialized();
    const id = nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    send({ method, id, params });
    return response;
  };

  const ensureInitialized = (): Promise<void> => {
    initialization ??= (async () => {
      child = spawn(
        options.command ?? "codex",
        [...(options.commandArgs ?? []), "app-server"],
        {
          env: { ...process.env, ...options.env },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      // The app-server is a reusable helper. Its pipes must not keep a CLI
      // invocation alive after all Prism work has completed.
      child.unref();
      lineReader = createInterface({ input: child.stdout });
      lineReader.on("line", (line) => handleMessage(line));
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (text.trim().length === 0) return;
        for (const active of turns.values()) {
          active.events.push({ kind: "output", text });
        }
      });
      child.once("error", (error) => failTransport(error));
      child.once("exit", (code, signal) => {
        failTransport(
          new Error(
            `Codex App Server exited (${code === null ? signal : String(code)})`,
          ),
        );
      });

      const id = 0;
      const initialized = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      send({
        method: "initialize",
        id,
        params: {
          clientInfo: {
            name: "prism",
            title: "Prism DAG Orchestrator",
            version: "0.1.0",
          },
        },
      });
      await initialized;
      send({ method: "initialized", params: {} });
    })();
    return initialization;
  };

  const handleMessage = (line: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      broadcastProtocolError(`invalid JSON from Codex App Server: ${line}`);
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message["id"] === "number" && !("method" in message)) {
      const response = message as unknown as RpcResponse;
      const waiter = pending.get(response.id);
      if (waiter === undefined) return;
      pending.delete(response.id);
      if (response.error !== undefined) {
        waiter.reject(
          new Error(
            typeof response.error.message === "string"
              ? response.error.message
              : "Codex App Server request failed",
          ),
        );
      } else waiter.resolve(response.result);
      return;
    }
    if (typeof message["method"] === "string") {
      void handleNotification(message as unknown as RpcNotification);
    }
  };

  const handleNotification = async (
    notification: RpcNotification,
  ): Promise<void> => {
    const params = isRecord(notification.params) ? notification.params : {};
    const threadId =
      typeof params["threadId"] === "string" ? params["threadId"] : undefined;
    if (threadId === undefined) return;
    const active = turns.get(threadId);
    if (active === undefined) return;
    if (
      notification.method === "item/agentMessage/delta" &&
      typeof params["delta"] === "string"
    ) {
      active.events.push({ kind: "output", text: params["delta"] });
      return;
    }
    if (notification.method !== "turn/completed") return;

    const turn = isRecord(params["turn"]) ? params["turn"] : {};
    const result = await readWorkerResult(active.input).catch(
      (error: unknown) => ({
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
        failureClass: "transient_infra" as const,
      }),
    );
    if (result !== undefined) {
      active.events.push({ kind: "result", result });
    } else {
      const status =
        typeof turn["status"] === "string" ? turn["status"] : "unknown";
      const turnError = isRecord(turn["error"]) ? turn["error"] : {};
      const detail =
        typeof turnError["message"] === "string"
          ? `: ${turnError["message"]}`
          : "";
      active.events.push({
        kind: "protocol_error",
        error: `Codex App Server turn ${status} without ${WORKER_RESULT_FILE}${detail}`,
      });
    }
    active.events.end();
  };

  const failTransport = (error: Error): void => {
    initialization = undefined;
    child = undefined;
    lineReader?.close();
    lineReader = undefined;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    broadcastProtocolError(error.message);
  };

  const broadcastProtocolError = (error: string): void => {
    for (const active of turns.values()) {
      active.events.push({ kind: "protocol_error", error });
      active.events.end();
    }
  };

  const beginTurn = async (
    input: AgentSessionInput,
    threadId: string,
  ): Promise<AgentSession> => {
    const events = new EventQueue();
    const active: ActiveTurn = { input, events, turnId: "" };
    turns.set(threadId, active);
    try {
      const result = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt }],
        cwd: input.worktreeDir,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.reasoningEffort === undefined
          ? {}
          : { effort: options.reasoningEffort }),
      });
      const record = isRecord(result) ? result : {};
      const turn = isRecord(record["turn"]) ? record["turn"] : {};
      if (typeof turn["id"] !== "string") {
        throw new Error("Codex App Server turn/start returned no turn id");
      }
      active.turnId = turn["id"];
      return { id: threadId, state: { turnId: active.turnId } };
    } catch (error: unknown) {
      turns.delete(threadId);
      throw error;
    }
  };

  const client: CodexAppServerClient = {
    async start(input) {
      const result = await request("thread/start", {
        cwd: input.worktreeDir,
        approvalPolicy: "never",
        sandbox: input.sandbox ?? "workspace-write",
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.reasoningEffort === undefined
          ? {}
          : { config: { model_reasoning_effort: options.reasoningEffort } }),
      });
      const record = isRecord(result) ? result : {};
      const thread = isRecord(record["thread"]) ? record["thread"] : {};
      if (typeof thread["id"] !== "string") {
        throw new Error("Codex App Server thread/start returned no thread id");
      }
      return beginTurn(input, thread["id"]);
    },
    async resume(input, session) {
      await request("thread/resume", {
        threadId: session.id,
        cwd: input.worktreeDir,
        approvalPolicy: "never",
        sandbox: input.sandbox ?? "workspace-write",
        ...(options.model === undefined ? {} : { model: options.model }),
      });
      return beginTurn(input, session.id);
    },
    async steer(session, message) {
      const active = turns.get(session.id);
      if (active === undefined || active.turnId.length === 0) {
        throw new Error(`no active Codex App Server turn for ${session.id}`);
      }
      await request("turn/steer", {
        threadId: session.id,
        expectedTurnId: active.turnId,
        input: [{ type: "text", text: message }],
      });
    },
    async interrupt(session) {
      const active = turns.get(session.id);
      const turnId = active?.turnId ?? sessionTurnId(session.state);
      if (turnId === undefined || turnId.length === 0) return;
      await request("turn/interrupt", { threadId: session.id, turnId });
    },
    async *events(session) {
      const queue = turns.get(session.id)?.events;
      if (queue === undefined) {
        yield {
          kind: "protocol_error",
          error: `no active Codex App Server event stream for ${session.id}`,
        } as const;
        return;
      }
      try {
        for (;;) {
          const next = await queue.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        turns.delete(session.id);
      }
    },
    close() {
      const running = child;
      failTransport(new Error("Codex App Server transport closed"));
      turns.clear();
      if (running !== undefined) {
        running.stdin.destroy();
        running.stdout.destroy();
        running.stderr.destroy();
        if (!running.killed) running.kill("SIGTERM");
      }
      return Promise.resolve();
    },
  };
  return Object.freeze(client);
}

async function readWorkerResult(input: AgentSessionInput) {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(input.nodeDir, WORKER_RESULT_FILE), "utf8"),
    );
    return parseWorkerResult(value);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sessionTurnId(state: JsonValue): string | undefined {
  return isRecord(state) && typeof state["turnId"] === "string"
    ? state["turnId"]
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
