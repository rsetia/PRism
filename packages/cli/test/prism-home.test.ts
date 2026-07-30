import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  missingPrismHomeMessage,
  resolvePrismProjectPaths,
} from "../src/prism-home.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "prism-home-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolvePrismProjectPaths", () => {
  test("derives every project path from PRISM_HOME and the git root", () => {
    const root = temporaryDirectory();
    const repo = join(root, "Conversation Coach");
    const nested = join(repo, "packages", "app");
    const prismHome = join(root, "prism");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], {
      cwd: repo,
      stdio: "ignore",
    });

    expect(resolvePrismProjectPaths(nested, { PRISM_HOME: prismHome })).toEqual(
      {
        repoDir: realpathSync(repo),
        projectSlug: "conversation-coach",
        prismHome,
        beadsRepoDir: join(prismHome, "beads", "conversation-coach"),
        storePath: join(prismHome, "store", "conversation-coach", "runs.db"),
        worktreeBaseDir: join(prismHome, "worktrees", "conversation-coach"),
      },
    );
  });

  test("leaves managed paths undefined when PRISM_HOME is absent", () => {
    const repo = temporaryDirectory();
    expect(resolvePrismProjectPaths(repo, {})).toMatchObject({
      repoDir: repo,
      prismHome: undefined,
      beadsRepoDir: undefined,
      storePath: undefined,
      worktreeBaseDir: undefined,
    });
  });

  test("rejects relative and filesystem-root PRISM_HOME values", () => {
    const repo = temporaryDirectory();
    expect(() =>
      resolvePrismProjectPaths(repo, { PRISM_HOME: "relative/path" }),
    ).toThrow("PRISM_HOME must be an absolute path");
    expect(() => resolvePrismProjectPaths(repo, { PRISM_HOME: "/" })).toThrow(
      "PRISM_HOME must not be a filesystem root",
    );
  });

  test("provides an actionable missing-variable message", () => {
    expect(missingPrismHomeMessage("--store <db>")).toContain(
      "set it to an absolute directory containing beads/, store/, and worktrees/",
    );
  });
});
