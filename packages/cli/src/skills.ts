/**
 * Prism ships agent skills next to the binary and installs them into the
 * agent's own skills directory, where they are auto-discovered from their
 * frontmatter description. Without this, a skill is only reachable by
 * pasting its absolute path — which no consumer of a published package
 * could know.
 */
import { cp, lstat, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prism drives Codex and is agent-agnostic by design, so the same skill
 * installs into either home.
 */
export type SkillAgent = "claude" | "codex";
export type SkillScope = "user" | "project";

export const SKILL_AGENTS: readonly SkillAgent[] = ["claude", "codex"];

export interface BundledSkill {
  readonly name: string;
  readonly description: string;
  /** Directory holding SKILL.md and any supporting files. */
  readonly sourceDir: string;
}

export interface InstalledSkill {
  readonly name: string;
  readonly path: string;
  /** True when an existing installation was overwritten. */
  readonly replaced: boolean;
}

/**
 * `dist/` and `skills/` are siblings in both the workspace and the packed
 * tarball, so one relative path serves both.
 */
export function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills/", import.meta.url));
}

export async function listBundledSkills(
  skillsDir: string = bundledSkillsDir(),
): Promise<readonly BundledSkill[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: BundledSkill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const sourceDir = join(skillsDir, entry.name);
    let content: string;
    try {
      content = await readFile(join(sourceDir, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(content);
    skills.push({
      name: frontmatter.name ?? entry.name,
      description: frontmatter.description ?? "",
      sourceDir,
    });
  }
  return skills;
}

/**
 * User scope installs for every repository; project scope commits the skill
 * alongside the code it plans.
 */
export function resolveSkillsInstallDir(
  agent: SkillAgent,
  scope: SkillScope,
  repoDir: string,
  home: string = homedir(),
): string {
  const agentDir = `.${agent}`;
  return scope === "project"
    ? join(repoDir, agentDir, "skills")
    : join(home, agentDir, "skills");
}

/**
 * Copy whole skill directories, not just SKILL.md — a skill may carry
 * scripts and references beside it.
 */
export async function installSkills(
  skills: readonly BundledSkill[],
  targetDir: string,
  force: boolean,
): Promise<readonly InstalledSkill[]> {
  const installed: InstalledSkill[] = [];
  for (const skill of skills) {
    const destination = join(targetDir, skill.name);
    const replaced = await pathExists(destination);
    if (replaced && !force) {
      throw new Error(
        `${destination} already exists; pass --force to overwrite it`,
      );
    }
    if (replaced) {
      await rm(destination, { recursive: true, force: true });
    }
    await cp(skill.sourceDir, destination, { recursive: true });
    installed.push({ name: skill.name, path: destination, replaced });
  }
  return installed;
}

/** Frontmatter is read for display only; the agent re-parses it at load. */
function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (match?.[1] === undefined) return {};
  const fields: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (field?.[1] === undefined || field[2] === undefined) continue;
    const value = field[2].trim().replace(/^["']|["']$/g, "");
    if (value.length === 0) continue;
    if (field[1] === "name") {
      fields.name = value;
    } else {
      fields.description = value;
    }
  }
  return fields;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}
