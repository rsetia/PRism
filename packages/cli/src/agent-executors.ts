import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  builtinExecutors,
  createExecutorRegistry,
  type ExecutorRegistry,
} from "@rsetia/prism";
import {
  createBeadsUpdateExecutor,
  createCodexAppServerBackend,
  createCodexAppServerStdioClient,
  createCodexEngine,
  createCodexExecutor,
  createFileAgentSessionStore,
  createFileLogBackend,
  createGitWorktreeProvisioner,
  createMergePrExecutor,
  type AgentSessionBackend,
  type CodexAppServerClient,
  TRUSTED_LOCAL_AGENT_EXECUTION_POLICY,
} from "@rsetia/prism/node";
import { resolvePrismProjectPaths } from "./prism-home.js";

export const DEFAULT_CODEX_MODEL = "gpt-5.6-terra";
export const DEFAULT_CODEX_REASONING_EFFORT = "medium";

export interface AgentExecutorRegistryOptions {
  /** Git repository Codex implement/merge nodes mutate. Default cwd. */
  readonly repoDir?: string;
  /** Parent directory for isolated git worktrees. Default PRISM_HOME, then OS temp. */
  readonly worktreeBaseDir?: string;
  /** Parent directory for durable worker logs. Default PRISM_HOME, then OS temp. */
  readonly logBaseDir?: string;
  /** Codex executable. Default "codex". */
  readonly codexCommand?: string;
  /** Model passed to `codex exec`. Default gpt-5.6-terra. */
  readonly codexModel?: string;
  /** Codex reasoning effort. Default medium. */
  readonly codexReasoningEffort?: string;
  /** Worker transport. Default "exec"; "app-server" enables durable threads. */
  readonly codexBackend?: "exec" | "app-server";
  /** Selects a structured backend when embedding the CLI registry. */
  readonly sessionBackend?: AgentSessionBackend;
}

export interface AgentExecutorRegistry extends ExecutorRegistry {
  /** Release shared agent transports created by this registry. */
  close(): Promise<void>;
}

/**
 * The operator-facing executor set. Keeping it in one factory is important:
 * `run` and `resume` must register the same names or a durable agent run can
 * start successfully and then become impossible to recover.
 */
export function createAgentExecutorRegistry(
  options: AgentExecutorRegistryOptions = {},
): AgentExecutorRegistry {
  const projectPaths = resolvePrismProjectPaths(options.repoDir);
  const repoDir = projectPaths.repoDir;
  const worktreeBaseDir = resolve(
    options.worktreeBaseDir ??
      projectPaths.worktreeBaseDir ??
      join(tmpdir(), "prism-worktrees", projectPaths.projectSlug),
  );
  const logBaseDir = resolve(
    options.logBaseDir ??
      projectPaths.logBaseDir ??
      join(tmpdir(), "prism-logs", projectPaths.projectSlug),
  );
  const logBackend = createFileLogBackend({ baseDir: logBaseDir });
  const codexEngine = createCodexEngine({
    executionPolicy: TRUSTED_LOCAL_AGENT_EXECUTION_POLICY,
    ...(options.codexCommand === undefined
      ? {}
      : { command: options.codexCommand }),
    model: options.codexModel ?? DEFAULT_CODEX_MODEL,
    reasoningEffort:
      options.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
  });
  const appServerClient: CodexAppServerClient | undefined =
    options.sessionBackend === undefined &&
    options.codexBackend === "app-server"
      ? createCodexAppServerStdioClient({
          ...(options.codexCommand === undefined
            ? {}
            : { command: options.codexCommand }),
          model: options.codexModel ?? DEFAULT_CODEX_MODEL,
          reasoningEffort:
            options.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
          executionPolicy: TRUSTED_LOCAL_AGENT_EXECUTION_POLICY,
        })
      : undefined;
  const sessionBackend =
    options.sessionBackend ??
    (appServerClient === undefined
      ? undefined
      : createCodexAppServerBackend(appServerClient));
  const provisioner = createGitWorktreeProvisioner({
    repoDir,
    baseDir: worktreeBaseDir,
  });

  const codexExecutor = (name: "implement" | "merge_resolve" | "finalize_pr") =>
    createCodexExecutor({
      name,
      // Preflight policy validation must run for both execution transports.
      engine: codexEngine,
      ...(sessionBackend === undefined ? {} : { sessionBackend }),
      ...(sessionBackend === undefined
        ? {}
        : {
            // Session records must outlive both a provisioned worktree and
            // the process that created this registry. Logs are already kept
            // in the project-scoped durable Prism directory.
            sessionStore: createFileAgentSessionStore(
              join(logBaseDir, "agent-sessions"),
            ),
          }),
      provisioner,
      logBackend,
    });
  const registry = createExecutorRegistry([
    ...builtinExecutors,
    codexExecutor("implement"),
    codexExecutor("merge_resolve"),
    codexExecutor("finalize_pr"),
    // Kept for hand-authored graphs that only need deterministic PR merging.
    createMergePrExecutor({ cwd: repoDir }),
    createBeadsUpdateExecutor({ cwd: repoDir }),
  ]);
  return Object.freeze({
    ...registry,
    close: () => appServerClient?.close() ?? Promise.resolve(),
  });
}
