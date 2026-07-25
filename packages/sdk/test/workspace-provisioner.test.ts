import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createGitWorktreeProvisioner } from "../src/node/index.js";
import type { WorkspaceProvisioner } from "../src/node/index.js";

const execFileAsync = promisify(execFile);

const root = mkdtempSync(join(tmpdir(), "prism-worktree-"));
const repoDir = join(root, "repo");
const worktreesDir = join(root, "worktrees");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

beforeAll(async () => {
  mkdtempSync(join(root, "seed-")); // ensure root exists on all platforms
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

describe("createGitWorktreeProvisioner", () => {
  test("provisions an isolated worktree on a new branch", async () => {
    const p = provisioner();
    const workspace = await p.provision({
      runId: "r",
      nodeId: "n",
      attempt: 1,
    });
    expect(existsSync(workspace.dir)).toBe(true);
    expect(existsSync(join(workspace.dir, "README.md"))).toBe(true);

    const branchAtWorktree = await git(
      workspace.dir,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    );
    expect(branchAtWorktree).toBe(workspace.branch);
    expect(workspace.branch).not.toBe("main");

    await p.release(workspace);
  });

  test("release removes the worktree", async () => {
    const p = provisioner();
    const workspace = await p.provision({
      runId: "r",
      nodeId: "m",
      attempt: 1,
    });
    expect(existsSync(workspace.dir)).toBe(true);
    await p.release(workspace);
    expect(existsSync(workspace.dir)).toBe(false);
  });

  test("distinct attempts get distinct worktrees and branches", async () => {
    const p = provisioner();
    const first = await p.provision({ runId: "r", nodeId: "x", attempt: 1 });
    const second = await p.provision({ runId: "r", nodeId: "x", attempt: 2 });
    expect(first.dir).not.toBe(second.dir);
    expect(first.branch).not.toBe(second.branch);
    await p.release(first);
    await p.release(second);
  });

  test("release is idempotent", async () => {
    const p = provisioner();
    const workspace = await p.provision({
      runId: "r",
      nodeId: "y",
      attempt: 1,
    });
    await p.release(workspace);
    await expect(p.release(workspace)).resolves.toBeUndefined();
  });
});
