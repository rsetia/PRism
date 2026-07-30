import { execFileSync } from "node:child_process";
import { basename, isAbsolute, join, parse, resolve } from "node:path";

export const PRISM_HOME_ENV = "PRISM_HOME";

export interface PrismProjectPaths {
  /** Resolved git root, or the supplied directory when it is not a git repo. */
  readonly repoDir: string;
  readonly projectSlug: string;
  /** Undefined when PRISM_HOME is not configured. */
  readonly prismHome: string | undefined;
  readonly beadsRepoDir: string | undefined;
  readonly storePath: string | undefined;
  readonly worktreeBaseDir: string | undefined;
  readonly logBaseDir: string | undefined;
}

/**
 * Resolve every operator-owned Prism path from one environment variable.
 * Explicit CLI paths still override these defaults at their call sites.
 */
export function resolvePrismProjectPaths(
  repoDir: string = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): PrismProjectPaths {
  const resolvedRepoDir = resolveGitRoot(repoDir);
  const projectSlug = slugProjectName(basename(resolvedRepoDir));
  const prismHome = parsePrismHome(env[PRISM_HOME_ENV]);
  return Object.freeze({
    repoDir: resolvedRepoDir,
    projectSlug,
    prismHome,
    beadsRepoDir:
      prismHome === undefined
        ? undefined
        : join(prismHome, "beads", projectSlug),
    storePath:
      prismHome === undefined
        ? undefined
        : join(prismHome, "store", projectSlug, "runs.db"),
    worktreeBaseDir:
      prismHome === undefined
        ? undefined
        : join(prismHome, "worktrees", projectSlug),
    logBaseDir:
      prismHome === undefined
        ? undefined
        : join(prismHome, "logs", projectSlug),
  });
}

export function missingPrismHomeMessage(purpose: string): string {
  return `${PRISM_HOME_ENV} is not set; set it to an absolute directory containing beads/, store/, worktrees/, and logs/, or pass an explicit ${purpose}`;
}

function parsePrismHome(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const normalized = value.trim();
  if (!isAbsolute(normalized)) {
    throw new Error(`${PRISM_HOME_ENV} must be an absolute path`);
  }
  const resolved = resolve(normalized);
  if (resolved === parse(resolved).root) {
    throw new Error(`${PRISM_HOME_ENV} must not be a filesystem root`);
  }
  return resolved;
}

function resolveGitRoot(directory: string): string {
  const resolved = resolve(directory);
  try {
    return resolve(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: resolved,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return resolved;
  }
}

function slugProjectName(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^[._-]+|[._-]+$/g, "");
  if (slug.length === 0) {
    throw new Error("repository directory name cannot form a project slug");
  }
  return slug;
}
