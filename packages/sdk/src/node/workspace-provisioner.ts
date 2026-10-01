import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { encodePathComponent } from "./path-component.js";

/**
 * The WorkspaceProvisioner port (plan §14, from PRism-py). It owns the
 * isolated environment a worker mutates — creating it and tearing it
 * down. This exists because parallel agents mutate one git repository:
 * each attempt gets its own worktree over a shared object store. No
 * general orchestrator has this seam, because the problem is
 * agent-specific.
 */

export interface WorkspaceHandle {
  /** Absolute path the worker should run in. */
  readonly dir: string;
  /** The branch checked out there, when the provisioner made one. */
  readonly branch?: string;
}

export interface ProvisionInput {
  readonly runId: string;
  readonly nodeId: string;
  /** 1-based attempt, so a retry gets a fresh, distinctly-named worktree. */
  readonly attempt: number;
  /**
   * Branch a NEW worktree branch starts from, fetched from the remote first
   * so the worker begins at the current integration head rather than at
   * whatever the operator's checkout happens to be. Ignored when the
   * worktree branch already exists (a retry or reset re-enters it).
   */
  readonly baseBranch?: string;
  /** Remote `baseBranch` lives on. Default "origin". */
  readonly remote?: string;
}

export interface WorkspaceReleaseOptions {
  /** Keep the provisioned branch so failed work remains recoverable. */
  readonly preserveBranch?: boolean;
}

export interface WorkspaceProvisioner {
  /** Whether commands in the workspace cross a container/VM boundary. */
  readonly isolation?: "host" | "isolated";
  provision(input: ProvisionInput): Promise<WorkspaceHandle>;
  /**
   * Tears down the workspace. Idempotent; after this resolves, handle.dir no
   * longer exists. A caller may preserve its branch for failure recovery.
   */
  release(
    handle: WorkspaceHandle,
    options?: WorkspaceReleaseOptions,
  ): Promise<void>;
  /** Optionally releases an underlying client or connection pool. */
  close?(): Promise<void>;
}

export interface GitWorktreeProvisionerOptions {
  /** The repository to add worktrees to. */
  readonly repoDir: string;
  /** Directory under which worktrees are created. */
  readonly baseDir: string;
  /** Ref the new branch starts from. Default "HEAD". */
  readonly baseRef?: string;
  /** Branch-name prefix for provisioned worktrees. Default "prism/". */
  readonly branchPrefix?: string;
  /**
   * Git command runner. Tests inject faults here; production uses `git`
   * directly. @internal
   */
  readonly git?: GitRunner;
  /** Attempts for a git mutation that fails on a transient lock. Default 3. */
  readonly lockRetryAttempts?: number;
}

/** Runs one git command in `cwd`, resolving with stdout. @internal */
export type GitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<string>;

/**
 * Provision worktrees with `git worktree` (plan §14). Each provision is an
 * isolated checkout over the repo's shared object store — cheap, and the
 * one abstraction no general orchestrator has.
 */
export function createGitWorktreeProvisioner(
  options: GitWorktreeProvisionerOptions,
): WorkspaceProvisioner {
  const repoDir = resolve(options.repoDir);
  const baseDir = resolve(options.baseDir);
  const baseRef = options.baseRef ?? "HEAD";
  const branchPrefix = sanitizeBranchName(options.branchPrefix ?? "prism/");
  const git = options.git ?? runGit;
  const lockRetryAttempts = Math.max(1, options.lockRetryAttempts ?? 3);
  // Every mutation of the shared repository (fetch, worktree add/remove/prune,
  // branch -D) goes through this per-repository lock, and transient lock
  // contention from other processes is retried.
  const mutate = (args: readonly string[]): Promise<string> =>
    withRepoLock(repoDir, () =>
      retryOnGitLock(() => git(repoDir, args), lockRetryAttempts),
    );

  return Object.freeze({
    isolation: "host" as const,
    async provision(input: ProvisionInput): Promise<WorkspaceHandle> {
      if (!Number.isInteger(input.attempt) || input.attempt < 1) {
        throw new Error("workspace attempt must be an integer greater than 0");
      }

      const branch = `${branchPrefix}/${encodePathComponent(
        input.runId,
        "workspace runId",
      )}/${encodePathComponent(input.nodeId, "workspace nodeId")}/a${String(
        input.attempt,
      )}`;
      await mkdir(baseDir, { recursive: true });
      const dir = await mkdtemp(
        join(
          baseDir,
          `worktree-${safePathPart(input.runId)}-${safePathPart(input.nodeId)}-a${String(input.attempt)}-`,
        ),
      );

      try {
        await withRepoLock(repoDir, async () => {
          const branchExisted = await localBranchExists(repoDir, branch);
          const startPoint = branchExisted
            ? undefined
            : await resolveStartPoint(repoDir, input, baseRef, (args) =>
                retryOnGitLock(() => git(repoDir, args), lockRetryAttempts),
              );
          // `--no-track`: a new branch started from a remote-tracking ref
          // would otherwise write upstream configuration into the shared
          // .git/config, and concurrent provisions race on its lock. Nothing
          // in PRism relies on upstream tracking.
          const args = branchExisted
            ? ["worktree", "add", dir, branch]
            : [
                "worktree",
                "add",
                "--no-track",
                "-b",
                branch,
                dir,
                startPoint ?? baseRef,
              ];
          await retryOnGitLock(
            () => git(repoDir, args),
            lockRetryAttempts,
            async () => {
              // Undo a partial `worktree add` so the retry starts clean: drop
              // stale worktree metadata, empty the target directory, and
              // delete a branch this attempt created but never checked out.
              await git(repoDir, ["worktree", "prune"]).catch(() => undefined);
              await rm(dir, { recursive: true, force: true });
              await mkdir(dir, { recursive: true });
              if (
                !branchExisted &&
                (await localBranchExists(repoDir, branch)) &&
                !(await branchCheckedOut(git, repoDir, branch))
              ) {
                await git(repoDir, ["branch", "-D", branch]).catch(
                  () => undefined,
                );
              }
            },
          );
        });
      } catch (error: unknown) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }

      return Object.freeze({ dir, branch });
    },

    async release(
      handle: WorkspaceHandle,
      releaseOptions: WorkspaceReleaseOptions = {},
    ): Promise<void> {
      const dir = resolve(handle.dir);
      try {
        await mutate(["worktree", "remove", "--force", dir]);
      } catch (error: unknown) {
        // `release` is deliberately idempotent. A missing directory means
        // there is no workspace left to protect; prune stale git metadata.
        if (await pathExists(dir)) {
          throw error;
        }
        await mutate(["worktree", "prune"]).catch(() => undefined);
      }

      if (
        releaseOptions.preserveBranch !== true &&
        handle.branch !== undefined
      ) {
        await mutate(["branch", "-D", handle.branch]).catch(() => undefined);
      }
    },
  });
}

/**
 * Where a new worktree branch starts. With a baseBranch: fetch it from the
 * remote and use the remote-tracking ref; a repository without that remote
 * (a local-only checkout, or tests) falls back to the local branch of the
 * same name. Without a baseBranch: the configured baseRef, as before.
 */
async function resolveStartPoint(
  repoDir: string,
  input: ProvisionInput,
  baseRef: string,
  gitMutate: (args: readonly string[]) => Promise<string>,
): Promise<string> {
  if (input.baseBranch === undefined) {
    return baseRef;
  }
  const remote = input.remote ?? "origin";
  const base = input.baseBranch;
  const remotes = (await runGit(repoDir, ["remote"]))
    .split(/\r?\n/)
    .map((name) => name.trim());
  if (!remotes.includes(remote)) {
    if (await localBranchExists(repoDir, base)) {
      return `refs/heads/${base}`;
    }
    throw new Error(
      `cannot start worktree from ${quoteArgument(base)}: remote ${quoteArgument(remote)} is not configured and no local branch exists`,
    );
  }
  const target = `refs/remotes/${remote}/${base}`;
  try {
    await gitMutate([
      "fetch",
      "--quiet",
      remote,
      `+refs/heads/${base}:${target}`,
    ]);
  } catch (fetchError: unknown) {
    throw new Error(
      `cannot start worktree from ${quoteArgument(base)}: fetch from ${quoteArgument(remote)} failed`,
      { cause: fetchError },
    );
  }
  return target;
}

async function localBranchExists(
  cwd: string,
  branch: string,
): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd, encoding: "utf8" },
      (error) => {
        if (error === null) {
          resolvePromise(true);
          return;
        }
        if (error.code === 1) {
          resolvePromise(false);
          return;
        }
        rejectPromise(
          new Error(
            `git show-ref failed while checking ${quoteArgument(branch)}`,
            { cause: error },
          ),
        );
      },
    );
  });
}

const repoLocks = new Map<string, Promise<unknown>>();

/**
 * Serializes `fn` with every other mutation of the same repository in this
 * process. Parallel nodes share one `.git` directory; git takes file locks
 * (config, refs, worktrees) that concurrent commands otherwise fight over.
 */
async function withRepoLock<T>(
  repoDirInput: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Key on the canonical path so `/r`, `/r/` and a symlink share one lock.
  const repoDir = await realpath(resolve(repoDirInput)).catch(() =>
    resolve(repoDirInput),
  );
  const previous = repoLocks.get(repoDir) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  repoLocks.set(repoDir, settled);
  try {
    return await run;
  } finally {
    if (repoLocks.get(repoDir) === settled) {
      repoLocks.delete(repoDir);
    }
  }
}

const GIT_LOCK_ERROR =
  /could not lock config file|Unable to create '[^']*\.lock'|cannot lock ref/i;

/** Whether a git failure is transient lock contention worth retrying. @internal */
export function isGitLockError(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (GIT_LOCK_ERROR.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Runs `fn`, retrying lock contention (typically another process touching
 * the same repository) with short jittered backoff. `beforeRetry` repairs
 * any partial state the failed attempt left behind.
 */
async function retryOnGitLock<T>(
  fn: () => Promise<T>,
  attempts: number,
  beforeRetry?: () => Promise<void>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error: unknown) {
      if (attempt >= attempts || !isGitLockError(error)) {
        throw error;
      }
      await delay(50 * attempt + Math.floor(Math.random() * 100));
      if (beforeRetry !== undefined) {
        try {
          await beforeRetry();
        } catch {
          // Cleanup is best effort: never let it mask the lock error the
          // caller would otherwise see if the next attempt also fails.
        }
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function branchCheckedOut(
  git: GitRunner,
  repoDir: string,
  branch: string,
): Promise<boolean> {
  const list = await git(repoDir, ["worktree", "list", "--porcelain"]).catch(
    () => "",
  );
  return list
    .split(/\r?\n/)
    .some((line) => line.trim() === `branch refs/heads/${branch}`);
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise(stdout);
          return;
        }

        const detail = stderr.trim();
        const command = ["git", ...args].map(quoteArgument).join(" ");
        rejectPromise(
          new Error(
            `${command} failed${detail.length === 0 ? "" : `: ${detail}`}`,
            { cause: error },
          ),
        );
      },
    );
  });
}

function quoteArgument(argument: string): string {
  return JSON.stringify(argument);
}

function sanitizeBranchName(value: string): string {
  const components = value
    .split("/")
    .filter((component) => component.length > 0)
    .map(safeRefComponent);
  if (components.length === 0) {
    return "prism/workspace";
  }
  return components.join("/");
}

function safeRefComponent(value: string): string {
  const sanitized = value
    .replaceAll(/[^a-zA-Z0-9._-]/g, "-")
    .replaceAll(/\.{2,}/g, ".")
    .replaceAll(/^-+|-+$/g, "")
    .replaceAll(/^\.+|\.+$/g, "")
    .replace(/\.lock$/i, "-lock")
    .slice(0, 64);
  return sanitized.length === 0 ? "_" : sanitized;
}

function safePathPart(value: string): string {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
  return sanitized.length === 0 ? "_" : sanitized;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
