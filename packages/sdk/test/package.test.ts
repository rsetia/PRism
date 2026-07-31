import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

/**
 * The automated replacement for "eyeball the tarball" (plan §7): what
 * `npm pack` would ship, asserted by rule. Catches every leak class —
 * tests, src, configs, coverage — without needing an update for each
 * new module.
 */
const execFileAsync = promisify(execFile);

const SDK_DIR = fileURLToPath(new URL("../", import.meta.url));
const CLI_DIR = fileURLToPath(new URL("../../cli/", import.meta.url));

interface PackReport {
  readonly files: readonly { readonly path: string }[];
}

async function packedFiles(packageDir: string): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--json"],
    { cwd: packageDir, timeout: 60_000 },
  );
  const reports = JSON.parse(stdout) as readonly PackReport[];
  const report = reports[0];
  if (report === undefined) {
    throw new Error("npm pack reported no package");
  }
  return report.files.map((entry) => entry.path).sort();
}

const ALLOWED =
  /^(package\.json|README\.md|LICENSE)$|^dist\/.+\.(js|d\.ts|js\.map|d\.ts\.map)$/;
/** The CLI also ships agent skills, which may carry files beside SKILL.md. */
const CLI_ALLOWED = new RegExp(`${ALLOWED.source}|^skills/[^/]+/.+`);
const FORBIDDEN =
  /(^|\/)(test|tests|fixture|fixtures|coverage)(\/|$)|\.(test|spec)\.|tsconfig|tsbuildinfo|\.env|^src\//;

function assertContents(
  files: readonly string[],
  required: readonly string[],
  allowed: RegExp = ALLOWED,
): void {
  for (const file of required) {
    expect(files).toContain(file);
  }
  for (const file of files) {
    expect(file).toMatch(allowed);
    expect(file).not.toMatch(FORBIDDEN);
  }
}

describe("packed tarball contents", () => {
  test("sdk ships only package.json and dist output", async () => {
    const files = await packedFiles(SDK_DIR);
    assertContents(files, [
      "package.json",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/node/index.js",
      "dist/node/index.d.ts",
      "dist/testing/index.js",
      "dist/testing/index.d.ts",
    ]);
  }, 60_000);

  // The skill is the only way a consumer discovers the planning workflow, so
  // it must be in the tarball — a `files` omission would drop it silently.
  test("cli ships package.json, dist output, the bin, and its agent skills", async () => {
    const files = await packedFiles(CLI_DIR);
    assertContents(
      files,
      [
        "package.json",
        "dist/main.js",
        "dist/cli.js",
        "skills/prism-plan-project/SKILL.md",
      ],
      CLI_ALLOWED,
    );
  }, 60_000);
});
