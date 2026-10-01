import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createGitWorktreeProvisioner,
  isGitLockError,
  type GitRunner,
} from "../src/node/workspace-provisioner.js";

const execFileAsync = promisify(execFile);

const root = mkdtempSync(join(tmpdir(), "prism-worktree-race-"));
const repoDir = join(root, "repo");
const remoteDir = join(root, "remote.git");
const worktreesDir = join(root, "worktrees");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

const realGit: GitRunner = async (cwd, args) => {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout;
};

beforeAll(async () => {
  await execFileAsync("git", ["init", "--bare", "-b", "main", remoteDir]);
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, "config", "user.email", "test@example.com");
  await git(repoDir, "config", "user.name", "Test");
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  await git(repoDir, "add", "README.md");
  await git(repoDir, "commit", "-m", "seed");
  await git(repoDir, "remote", "add", "origin", remoteDir);
  await git(repoDir, "push", "-q", "origin", "main:integration");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createGitWorktreeProvisioner under concurrency", () => {
  test("parallel provisions from a remote-tracking base all succeed", async () => {
    const p = createGitWorktreeProvisioner({ repoDir, baseDir: worktreesDir });
    const handles = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        p.provision({
          runId: "race",
          nodeId: `node-${String(index)}`,
          attempt: 1,
          baseBranch: "integration",
        }),
      ),
    );
    expect(handles).toHaveLength(8);
    for (const handle of handles) {
      expect(existsSync(join(handle.dir, "README.md"))).toBe(true);
    }
    await Promise.all(handles.map((handle) => p.release(handle)));
  });

  test("new branches carry no upstream configuration (--no-track)", async () => {
    const p = createGitWorktreeProvisioner({ repoDir, baseDir: worktreesDir });
    const handle = await p.provision({
      runId: "notrack",
      nodeId: "node",
      attempt: 1,
      baseBranch: "integration",
    });
    const merge = await git(
      repoDir,
      "config",
      "--get-regexp",
      "^branch\\..*\\.merge$",
    ).catch(() => "");
    expect(merge).not.toContain(handle.branch ?? "<none>");
    expect(merge).toBe("");
    await p.release(handle);
  });

  test("retries an injected lock error and leaves no partial branch behind", async () => {
    let injected = 0;
    const flaky: GitRunner = async (cwd, args) => {
      if (args[0] === "worktree" && args[1] === "add" && injected === 0) {
        injected += 1;
        // Mimic the real failure: the branch is created, then the config
        // write loses the lock race.
        const branchIndex = args.indexOf("-b");
        if (branchIndex !== -1) {
          await realGit(cwd, [
            "branch",
            "--no-track",
            args[branchIndex + 1] ?? "",
            args.at(-1) ?? "HEAD",
          ]);
        }
        throw new Error(
          "git worktree add failed: error: could not lock config file .git/config: File exists",
        );
      }
      return realGit(cwd, args);
    };
    const p = createGitWorktreeProvisioner({
      repoDir,
      baseDir: worktreesDir,
      git: flaky,
    });
    const handle = await p.provision({
      runId: "flaky",
      nodeId: "node",
      attempt: 1,
      baseBranch: "integration",
    });
    expect(injected).toBe(1);
    expect(existsSync(join(handle.dir, "README.md"))).toBe(true);
    await p.release(handle);
    const leftovers = await git(repoDir, "branch", "--list", "prism/flaky/*");
    expect(leftovers).toBe("");
  });

  test("does not retry genuine failures", async () => {
    let calls = 0;
    const broken: GitRunner = async (cwd, args) => {
      if (args[0] === "worktree" && args[1] === "add") {
        calls += 1;
        throw new Error("git worktree add failed: fatal: invalid reference");
      }
      return realGit(cwd, args);
    };
    const p = createGitWorktreeProvisioner({
      repoDir,
      baseDir: worktreesDir,
      git: broken,
    });
    await expect(
      p.provision({ runId: "broken", nodeId: "node", attempt: 1 }),
    ).rejects.toThrow(/invalid reference/);
    expect(calls).toBe(1);
  });

  test("release retries a lock error on worktree remove", async () => {
    let removeFailures = 0;
    const flakyRemove: GitRunner = async (cwd, args) => {
      if (
        args[0] === "worktree" &&
        args[1] === "remove" &&
        removeFailures === 0
      ) {
        removeFailures += 1;
        throw new Error(
          "git worktree remove failed: fatal: Unable to create '/r/.git/worktrees/x/locked.lock': File exists.",
        );
      }
      return realGit(cwd, args);
    };
    const p = createGitWorktreeProvisioner({
      repoDir,
      baseDir: worktreesDir,
      git: flakyRemove,
    });
    const handle = await p.provision({
      runId: "release",
      nodeId: "node",
      attempt: 1,
      baseBranch: "integration",
    });
    await p.release(handle);
    expect(removeFailures).toBe(1);
    expect(existsSync(handle.dir)).toBe(false);
  });

  test("classifies git lock contention", () => {
    expect(
      isGitLockError(
        new Error("error: could not lock config file .git/config: File exists"),
      ),
    ).toBe(true);
    expect(
      isGitLockError(
        new Error("outer", {
          cause: new Error(
            "fatal: Unable to create '/r/.git/index.lock': File exists.",
          ),
        }),
      ),
    ).toBe(true);
    expect(isGitLockError(new Error("cannot lock ref 'refs/heads/x'"))).toBe(
      true,
    );
    expect(isGitLockError(new Error("fatal: invalid reference: main"))).toBe(
      false,
    );
  });
});
