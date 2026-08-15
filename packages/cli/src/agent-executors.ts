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
  TRUSTED_LOCAL_AGENT_EXECUTION_POLICY,
} from "@rsetia/prism/node";
import { resolvePrismProjectPaths } from "./prism-home.js";

export interface AgentExecutorRegistryOptions {
  /** Git repository Codex implement/merge nodes mutate. Default cwd. */
  readonly repoDir?: string;
  /** Parent directory for isolated git worktrees. Default PRISM_HOME, then OS temp. */
  readonly worktreeBaseDir?: string;
  /** Parent directory for durable worker logs. Default PRISM_HOME, then OS temp. */
  readonly logBaseDir?: string;
  /** Codex executable. Default "codex". */
  readonly codexCommand?: string;
  /** Optional model passed to `codex exec`. */
  readonly codexModel?: string;
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
    executionPolicy: TRUSTED_LOCAL_AGENT_EXECUTION_POLICY,
    ...(options.codexCommand === undefined
      ? {}
      : { command: options.codexCommand }),
    ...(options.codexModel === undefined ? {} : { model: options.codexModel }),
  });
  const provisioner = createGitWorktreeProvisioner({
    repoDir,
    baseDir: worktreeBaseDir,
  });

  return createExecutorRegistry([
    ...builtinExecutors,
    createCodexExecutor({
      name: "implement",
      engine: codexEngine,
      provisioner,
      logBackend,
    }),
    createCodexExecutor({
      name: "merge_resolve",
      engine: codexEngine,
      provisioner,
      logBackend,
    }),
    createCodexExecutor({
      name: "finalize_pr",
      engine: codexEngine,
      provisioner,
      logBackend,
    }),
    // Kept for hand-authored graphs that only need deterministic PR merging.
    createMergePrExecutor({ cwd: repoDir }),
    createBeadsUpdateExecutor({ cwd: repoDir }),
  ]);
}
