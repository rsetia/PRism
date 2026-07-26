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
const FORBIDDEN =
  /(^|\/)(test|tests|fixture|fixtures|coverage)(\/|$)|\.(test|spec)\.|tsconfig|tsbuildinfo|\.env|^src\//;

function assertContents(
  files: readonly string[],
  required: readonly string[],
): void {
  for (const file of required) {
    expect(files).toContain(file);
  }
  for (const file of files) {
    expect(file).toMatch(ALLOWED);
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

  test("cli ships only package.json and dist output, including the bin", async () => {
    const files = await packedFiles(CLI_DIR);
    assertContents(files, ["package.json", "dist/main.js", "dist/cli.js"]);
  }, 60_000);
});
