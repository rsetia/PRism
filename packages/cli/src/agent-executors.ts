import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  builtinExecutors,
  createExecutorRegistry,
  type ExecutorRegistry,
} from "@rsetia/prism";
import {
  createBeadsUpdateExecutor,
  createCodexEngine,
  createCodexExecutor,
  createFileLogBackend,
  createGitWorktreeProvisioner,
  createMergePrExecutor,
  type AgentSessionBackend,
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
  /** Selects a structured backend when embedding the CLI registry. */
  readonly sessionBackend?: AgentSessionBackend;
}

/**
 * The operator-facing executor set. Keeping it in one factory is important:
 * `run` and `resume` must register the same names or a durable agent run can
 * start successfully and then become impossible to recover.
 */
export function createAgentExecutorRegistry(
  options: AgentExecutorRegistryOptions = {},
): ExecutorRegistry {
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
    ...(options.codexCommand === undefined
      ? {}
      : { command: options.codexCommand }),
    model: options.codexModel ?? DEFAULT_CODEX_MODEL,
    reasoningEffort:
      options.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
  });
  const provisioner = createGitWorktreeProvisioner({
    repoDir,
    baseDir: worktreeBaseDir,
  });

  const codexExecutor = (name: "implement" | "merge_resolve" | "finalize_pr") =>
    createCodexExecutor({
      name,
      ...(options.sessionBackend === undefined
        ? { engine: codexEngine }
        : { sessionBackend: options.sessionBackend }),
      provisioner,
      logBackend,
    });
  return createExecutorRegistry([
    ...builtinExecutors,
    codexExecutor("implement"),
    codexExecutor("merge_resolve"),
    codexExecutor("finalize_pr"),
    // Kept for hand-authored graphs that only need deterministic PR merging.
    createMergePrExecutor({ cwd: repoDir }),
    createBeadsUpdateExecutor({ cwd: repoDir }),
  ]);
}
