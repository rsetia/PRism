import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SDK_NAME = "@rsetia/prism";
const CLI_NAME = "@rsetia/prism-cli";
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
const REPOSITORY_URL = "git+https://github.com/rsetia/PRism.git";
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function expectedDistTag(version) {
  const withoutBuildMetadata = version.split("+", 1)[0] ?? version;
  return withoutBuildMetadata.includes("-") ? "next" : "latest";
}

function versionFromSource(source) {
  const matches = [
    ...source.matchAll(/export const SDK_VERSION = ["']([^"']+)["'];/g),
  ];
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

function hasReleaseHeading(changelog, version) {
  const escaped = version.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(
    String.raw`^## \[${escaped}\] - \d{4}-\d{2}-\d{2}$`,
    "m",
  ).test(changelog);
}

function checkPublishConfig(errors, packageJson, label, version) {
  const publishConfig = packageJson.publishConfig;
  if (
    publishConfig === null ||
    typeof publishConfig !== "object" ||
    Array.isArray(publishConfig)
  ) {
    errors.push(`${label} must define publishConfig`);
    return;
  }

  if (publishConfig.access !== "public") {
    errors.push(`${label} publishConfig.access must be "public"`);
  }
  if (publishConfig.provenance !== true) {
    errors.push(`${label} publishConfig.provenance must be true`);
  }
  if (publishConfig.registry !== PUBLIC_REGISTRY) {
    errors.push(`${label} publishConfig.registry must be "${PUBLIC_REGISTRY}"`);
  }

  const expected = expectedDistTag(version);
  if (publishConfig.tag !== expected) {
    errors.push(
      `${label} publishConfig.tag must be "${expected}" for version ${version}`,
    );
  }
}

export function collectReleaseMetadataErrors(state, options = {}) {
  const errors = [];
  const {
    rootPackage,
    sdkPackage,
    cliPackage,
    packageLock,
    sdkSource,
    readme,
    security,
    changelog,
  } = state;
  const release = options.release ?? false;

  if (rootPackage.private !== true) {
    errors.push("root package must remain private");
  }
  if (sdkPackage.name !== SDK_NAME) {
    errors.push(`SDK package name must be "${SDK_NAME}"`);
  }
  if (cliPackage.name !== CLI_NAME) {
    errors.push(`CLI package name must be "${CLI_NAME}"`);
  }
  if (sdkPackage.repository?.url !== REPOSITORY_URL) {
    errors.push(`SDK repository URL must be "${REPOSITORY_URL}"`);
  }
  if (cliPackage.repository?.url !== REPOSITORY_URL) {
    errors.push(`CLI repository URL must be "${REPOSITORY_URL}"`);
  }
  if (cliPackage.bin?.prism !== "dist/main.js") {
    errors.push('CLI bin.prism must be the normalized path "dist/main.js"');
  }

  const version = sdkPackage.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    errors.push(
      `SDK version must be valid SemVer, received ${String(version)}`,
    );
    return errors;
  }
  if (cliPackage.version !== version) {
    errors.push(
      `CLI version ${String(cliPackage.version)} must equal SDK version ${version}`,
    );
  }
  if (cliPackage.dependencies?.[SDK_NAME] !== version) {
    errors.push(`CLI dependency on ${SDK_NAME} must exactly equal ${version}`);
  }

  const lockedSdk = packageLock.packages?.["packages/sdk"];
  const lockedCli = packageLock.packages?.["packages/cli"];
  if (lockedSdk?.version !== version) {
    errors.push(`package-lock SDK version must equal ${version}`);
  }
  if (lockedCli?.version !== version) {
    errors.push(`package-lock CLI version must equal ${version}`);
  }
  if (lockedCli?.dependencies?.[SDK_NAME] !== version) {
    errors.push(
      `package-lock CLI dependency on ${SDK_NAME} must equal ${version}`,
    );
  }

  const sourceVersion = versionFromSource(sdkSource);
  if (sourceVersion === undefined) {
    errors.push("SDK source must declare exactly one SDK_VERSION constant");
  } else if (sourceVersion !== version) {
    errors.push(`SDK_VERSION ${sourceVersion} must equal ${version}`);
  }

  if (!readme.includes(`Status: \`${version}\``)) {
    errors.push(`README status must name version ${version}`);
  }
  if (!security.includes(`(\`${version}\`)`)) {
    errors.push(`SECURITY policy must name version ${version}`);
  }
  if (!/^## \[Unreleased\]$/m.test(changelog)) {
    errors.push('CHANGELOG must contain an "## [Unreleased]" section');
  }
  if (release && !hasReleaseHeading(changelog, version)) {
    errors.push(
      `release mode requires a dated CHANGELOG heading for ${version}`,
    );
  }

  checkPublishConfig(errors, sdkPackage, "SDK", version);
  checkPublishConfig(errors, cliPackage, "CLI", version);
  return errors;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function loadRepositoryState() {
  return {
    rootPackage: readJson("package.json"),
    sdkPackage: readJson("packages/sdk/package.json"),
    cliPackage: readJson("packages/cli/package.json"),
    packageLock: readJson("package-lock.json"),
    sdkSource: readFileSync(
      path.join(repoRoot, "packages/sdk/src/index.ts"),
      "utf8",
    ),
    readme: readFileSync(path.join(repoRoot, "README.md"), "utf8"),
    security: readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8"),
    changelog: readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8"),
  };
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function collectGitReleaseErrors(version) {
  const errors = [];
  if (git("status", "--porcelain") !== "") {
    errors.push("release mode requires a clean working tree");
  }

  const expectedTag = `v${version}`;
  const tags = git("tag", "--points-at", "HEAD")
    .split("\n")
    .filter((tag) => tag.length > 0);
  if (!tags.includes(expectedTag)) {
    errors.push(`release mode requires tag ${expectedTag} at HEAD`);
  }
  return errors;
}

function collectPublishDryRunErrors(version) {
  const errors = [];
  const tag = expectedDistTag(version);
  const packDir = mkdtempSync(path.join(tmpdir(), "prism-release-check-"));

  try {
    for (const candidate of [
      {
        directory: path.join(repoRoot, "packages/sdk"),
        name: SDK_NAME,
      },
      {
        directory: path.join(repoRoot, "packages/cli"),
        name: CLI_NAME,
      },
    ]) {
      let packReport;
      try {
        packReport = JSON.parse(
          execFileSync(
            "npm",
            ["pack", "--json", "--pack-destination", packDir],
            {
              cwd: candidate.directory,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 60_000,
            },
          ),
        )[0];
      } catch (error) {
        errors.push(`${candidate.name} could not be packed: ${String(error)}`);
        continue;
      }

      if (
        packReport === null ||
        typeof packReport !== "object" ||
        typeof packReport.filename !== "string"
      ) {
        errors.push(`${candidate.name} pack report had no tarball filename`);
        continue;
      }

      const tarball = path.join(packDir, packReport.filename);
      const published = spawnSync(
        "npm",
        [
          "publish",
          tarball,
          "--dry-run",
          "--json",
          "--tag",
          tag,
          "--access",
          "public",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        },
      );
      const publishedStderr = String(published.stderr ?? "");
      if (published.status !== 0) {
        errors.push(
          `${candidate.name} publish dry run failed: ${publishedStderr.trim()}`,
        );
        continue;
      }
      if (publishedStderr.includes("auto-corrected")) {
        errors.push(
          `${candidate.name} publish dry run auto-corrected its manifest`,
        );
      }

      try {
        const reports = JSON.parse(String(published.stdout));
        const report = reports[candidate.name] ?? reports;
        if (
          report.name !== candidate.name ||
          report.version !== version ||
          report.id !== `${candidate.name}@${version}`
        ) {
          errors.push(
            `${candidate.name} publish dry run returned unexpected identity`,
          );
        }
      } catch (error) {
        errors.push(
          `${candidate.name} publish dry run returned invalid JSON: ${String(error)}`,
        );
      }
    }
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }

  return errors;
}

function main() {
  const unknownArguments = process.argv
    .slice(2)
    .filter((argument) => argument !== "--publish" && argument !== "--release");
  if (unknownArguments.length > 0) {
    throw new Error(
      `unknown release-check argument: ${unknownArguments.join(", ")}`,
    );
  }

  const release = process.argv.includes("--release");
  const publish = release || process.argv.includes("--publish");
  const state = loadRepositoryState();
  const errors = collectReleaseMetadataErrors(state, { release });
  if (release && typeof state.sdkPackage.version === "string") {
    errors.push(...collectGitReleaseErrors(state.sdkPackage.version));
  }
  if (
    publish &&
    errors.length === 0 &&
    typeof state.sdkPackage.version === "string"
  ) {
    errors.push(...collectPublishDryRunErrors(state.sdkPackage.version));
  }

  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`[release-check] ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `[release-check] ${state.sdkPackage.version} metadata is aligned${publish ? " and publishable" : ""}${release ? " from the tagged commit" : ""}\n`,
  );
}

const entryPath =
  process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  main();
}
