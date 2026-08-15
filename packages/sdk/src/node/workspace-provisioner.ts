import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
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
}

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
        const branchExists = await localBranchExists(repoDir, branch);
        await runGit(
          repoDir,
          branchExists
            ? ["worktree", "add", dir, branch]
            : ["worktree", "add", "-b", branch, dir, baseRef],
        );
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
        await runGit(repoDir, ["worktree", "remove", "--force", dir]);
      } catch (error: unknown) {
        // `release` is deliberately idempotent. A missing directory means
        // there is no workspace left to protect; prune stale git metadata.
        if (await pathExists(dir)) {
          throw error;
        }
        await runGit(repoDir, ["worktree", "prune"]).catch(() => undefined);
      }

      if (
        releaseOptions.preserveBranch !== true &&
        handle.branch !== undefined
      ) {
        await runGit(repoDir, ["branch", "-D", handle.branch]).catch(
          () => undefined,
        );
      }
    },
  });
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

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8" },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolvePromise();
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
