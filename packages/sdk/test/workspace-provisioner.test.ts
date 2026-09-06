import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createGitWorktreeProvisioner,
  type WorkspaceProvisioner,
} from "../src/node/index.js";
import { runWorkspaceProvisionerContract } from "../src/testing/index.js";

const execFileAsync = promisify(execFile);

const root = mkdtempSync(join(tmpdir(), "prism-worktree-"));
const repoDir = join(root, "repo");
const worktreesDir = join(root, "worktrees");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

beforeAll(async () => {
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, "config", "user.email", "test@example.com");
  await git(repoDir, "config", "user.name", "Test");
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  await git(repoDir, "add", "README.md");
  await git(repoDir, "commit", "-m", "seed");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function provisioner(): WorkspaceProvisioner {
  return createGitWorktreeProvisioner({ repoDir, baseDir: worktreesDir });
}

runWorkspaceProvisionerContract("createGitWorktreeProvisioner", () =>
  Promise.resolve(provisioner()),
);

describe("createGitWorktreeProvisioner Git behavior", () => {
  test("checks out the repository on the reported new branch", async () => {
    const p = provisioner();
    const workspace = await p.provision({
      runId: "git",
      nodeId: "branch",
      attempt: 1,
    });
    expect(existsSync(join(workspace.dir, "README.md"))).toBe(true);

    const branchAtWorktree = await git(
      workspace.dir,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    );
    expect(branchAtWorktree).toBe(workspace.branch);
    expect(workspace.branch).not.toBe("main");
    const branch = workspace.branch;
    if (branch === undefined) {
      throw new Error("Git worktree provisioner did not report its branch");
    }
    await p.release(workspace, { preserveBranch: true });
    expect(await git(repoDir, "branch", "--list", branch)).toBe(branch);
    await git(repoDir, "branch", "-D", branch);
  });

  test("reattaches a preserved branch when an attempt is reset", async () => {
    const p = provisioner();
    const input = {
      runId: "recovery",
      nodeId: "preserved-attempt",
      attempt: 1,
    };
    const first = await p.provision(input);
    const branch = first.branch;
    if (branch === undefined) {
      throw new Error("Git worktree provisioner did not report its branch");
    }
    writeFileSync(join(first.dir, "RECOVERY.md"), "preserved\n");
    await git(first.dir, "add", "RECOVERY.md");
    await git(first.dir, "commit", "-m", "preserve attempt");
    const preservedHead = await git(first.dir, "rev-parse", "HEAD");

    await p.release(first, { preserveBranch: true });
    const resumed = await p.provision(input);
    expect(resumed.branch).toBe(branch);
    expect(existsSync(join(resumed.dir, "RECOVERY.md"))).toBe(true);
    expect(await git(resumed.dir, "rev-parse", "HEAD")).toBe(preservedHead);

    await p.release(resumed);
    expect(await git(repoDir, "branch", "--list", branch)).toBe("");
  });

  test("removes the temporary directory when Git provisioning fails", async () => {
    const failedBaseDir = join(root, "failed-worktrees");
    const p = createGitWorktreeProvisioner({
      repoDir,
      baseDir: failedBaseDir,
      baseRef: "refs/heads/does-not-exist",
    });

    await expect(
      p.provision({ runId: "failed", nodeId: "base-ref", attempt: 1 }),
    ).rejects.toThrow();
    expect(readdirSync(failedBaseDir)).toEqual([]);
  });
});

describe("createGitWorktreeProvisioner base branch", () => {
  test("starts a new branch from the fetched remote branch, not the stale local one", async () => {
    const remoteDir = join(root, "remote.git");
    await execFileAsync("git", ["init", "--bare", "-b", "main", remoteDir]);
    await git(repoDir, "remote", "add", "origin", remoteDir);
    await git(repoDir, "checkout", "-b", "integration");
    await git(repoDir, "push", "-u", "origin", "integration");
    // Advance integration on the remote from a separate clone, leaving the
    // local integration branch stale.
    const cloneDir = join(root, "clone");
    await execFileAsync("git", [
      "clone",
      "-q",
      "-b",
      "integration",
      remoteDir,
      cloneDir,
    ]);
    await git(cloneDir, "config", "user.email", "test@example.com");
    await git(cloneDir, "config", "user.name", "Test");
    writeFileSync(join(cloneDir, "merged.txt"), "landed upstream\n");
    await git(cloneDir, "add", "merged.txt");
    await git(cloneDir, "commit", "-m", "landed upstream");
    await git(cloneDir, "push", "-q", "origin", "integration");
    await git(repoDir, "checkout", "main");

    const p = provisioner();
    const workspace = await p.provision({
      runId: "base",
      nodeId: "fresh",
      attempt: 1,
      baseBranch: "integration",
    });
    expect(existsSync(join(workspace.dir, "merged.txt"))).toBe(true);
    await p.release(workspace);
  });

  test("falls back to a local branch when the remote is unavailable", async () => {
    await git(
      repoDir,
      "remote",
      "set-url",
      "origin",
      join(root, "missing.git"),
    );
    await git(repoDir, "checkout", "integration");
    writeFileSync(join(repoDir, "local-only.txt"), "local\n");
    await git(repoDir, "add", "local-only.txt");
    await git(repoDir, "commit", "-m", "local integration commit");
    await git(repoDir, "checkout", "main");

    const p = provisioner();
    const workspace = await p.provision({
      runId: "base",
      nodeId: "fallback",
      attempt: 1,
      baseBranch: "integration",
    });
    expect(existsSync(join(workspace.dir, "local-only.txt"))).toBe(true);
    await p.release(workspace);
  });

  test("rejects an unknown base branch instead of silently using HEAD", async () => {
    const p = provisioner();
    await expect(
      p.provision({
        runId: "base",
        nodeId: "unknown",
        attempt: 1,
        baseBranch: "does-not-exist",
      }),
    ).rejects.toThrow(/cannot start worktree from "does-not-exist"/);
  });
});
