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
  createGitWorktreeProvisioner,
  createMergePrExecutor,
} from "@rsetia/prism/node";

export interface AgentExecutorRegistryOptions {
  /** Git repository Codex implement/merge nodes mutate. Default cwd. */
  readonly repoDir?: string;
  /** Parent directory for isolated git worktrees. Default OS temp. */
  readonly worktreeBaseDir?: string;
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
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const worktreeBaseDir = resolve(
    options.worktreeBaseDir ?? join(tmpdir(), "prism-worktrees"),
  );
  const codexEngine = createCodexEngine({
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
    }),
    createCodexExecutor({
      name: "merge_resolve",
      engine: codexEngine,
      provisioner,
    }),
    // Kept for hand-authored graphs that only need deterministic PR merging.
    createMergePrExecutor({ cwd: repoDir }),
    createBeadsUpdateExecutor({ cwd: repoDir }),
  ]);
}
