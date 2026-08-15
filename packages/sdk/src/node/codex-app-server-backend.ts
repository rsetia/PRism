import type {
  AgentSession,
  AgentSessionBackend,
  AgentSessionEvent,
  AgentSessionInput,
} from "./agent-session-backend.js";

/**
 * Transport boundary for Codex App Server. Keeping JSON-RPC transport here
 * makes the structured adapter testable without a local Codex installation.
 */
export interface CodexAppServerClient {
  start(input: AgentSessionInput): Promise<AgentSession>;
  resume(
    input: AgentSessionInput,
    session: AgentSession,
  ): Promise<AgentSession>;
  steer(session: AgentSession, message: string): Promise<void>;
  interrupt(session: AgentSession): Promise<void>;
  events(session: AgentSession): AsyncIterable<AgentSessionEvent>;
}

/** First structured AgentSessionBackend; its client speaks Codex App Server JSON-RPC. */
export function createCodexAppServerBackend(
  client: CodexAppServerClient,
): AgentSessionBackend {
  return Object.freeze({
    name: "codex-app-server",
    start: (input: AgentSessionInput) => client.start(input),
    resume: (input: AgentSessionInput, session: AgentSession) =>
      client.resume(input, session),
    steer: (session: AgentSession, message: string) =>
      client.steer(session, message),
    interrupt: (session: AgentSession) => client.interrupt(session),
    events: (session: AgentSession) => client.events(session),
  });
}
