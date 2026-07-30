import { describe, expect, test } from "vitest";
import { collectReleaseMetadataErrors } from "./check-release.mjs";

const VERSION = "0.1.0-alpha.0";

function validState() {
  const sdkPackage = {
    name: "@rsetia/prism",
    version: VERSION,
    repository: {
      url: "git+https://github.com/rsetia/PRism.git",
    },
    publishConfig: {
      access: "public",
      provenance: true,
      registry: "https://registry.npmjs.org/",
      tag: "next",
    },
  };
  const cliPackage = {
    name: "@rsetia/prism-cli",
    version: VERSION,
    repository: {
      url: "git+https://github.com/rsetia/PRism.git",
    },
    bin: { prism: "dist/main.js" },
    dependencies: { "@rsetia/prism": VERSION },
    publishConfig: { ...sdkPackage.publishConfig },
  };

  return {
    rootPackage: { private: true },
    sdkPackage,
    cliPackage,
    packageLock: {
      packages: {
        "packages/sdk": {
          name: sdkPackage.name,
          version: VERSION,
        },
        "packages/cli": {
          name: cliPackage.name,
          version: VERSION,
          dependencies: { "@rsetia/prism": VERSION },
        },
      },
    },
    sdkSource: `export const SDK_VERSION = "${VERSION}";`,
    readme: `> **Status: \`${VERSION}\`**`,
    security: `Prism is pre-1.0 (\`${VERSION}\`).`,
    changelog: "# Changelog\n\n## [Unreleased]\n",
  };
}

describe("release metadata contract", () => {
  test("accepts aligned prerelease metadata", () => {
    expect(collectReleaseMetadataErrors(validState())).toEqual([]);
  });

  test("reports every independently drifted version", () => {
    const state = validState();
    state.cliPackage.version = "0.1.0-alpha.1";
    state.cliPackage.dependencies["@rsetia/prism"] = "^0.1.0";
    state.packageLock.packages["packages/sdk"].version = "0.1.0-alpha.2";
    state.packageLock.packages["packages/cli"].version = "0.1.0-alpha.3";
    state.packageLock.packages["packages/cli"].dependencies["@rsetia/prism"] =
      "workspace:*";
    state.sdkSource = 'export const SDK_VERSION = "0.0.0";';

    expect(collectReleaseMetadataErrors(state)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CLI version"),
        expect.stringContaining("CLI dependency"),
        expect.stringContaining("package-lock SDK"),
        expect.stringContaining("package-lock CLI version"),
        expect.stringContaining("package-lock CLI dependency"),
        expect.stringContaining("SDK_VERSION"),
      ]),
    );
  });

  test("requires safe npm publishing policy", () => {
    const state = validState();
    state.sdkPackage.repository.url = "git+https://example.test/prism.git";
    state.sdkPackage.publishConfig.access = "restricted";
    state.sdkPackage.publishConfig.provenance = false;
    state.cliPackage.bin.prism = "./dist/main.js";
    state.cliPackage.publishConfig.registry = "https://example.test/";
    state.cliPackage.publishConfig.tag = "latest";

    expect(collectReleaseMetadataErrors(state)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("repository URL"),
        expect.stringContaining("bin.prism"),
        expect.stringContaining("access"),
        expect.stringContaining("provenance"),
        expect.stringContaining("registry"),
        expect.stringContaining('tag must be "next"'),
      ]),
    );
  });

  test("stable versions require the latest dist-tag", () => {
    const state = validState();
    state.sdkPackage.version = "1.0.0+build-1";
    state.cliPackage.version = "1.0.0+build-1";
    state.cliPackage.dependencies["@rsetia/prism"] = "1.0.0+build-1";
    state.packageLock.packages["packages/sdk"].version = "1.0.0+build-1";
    state.packageLock.packages["packages/cli"].version = "1.0.0+build-1";
    state.packageLock.packages["packages/cli"].dependencies["@rsetia/prism"] =
      "1.0.0+build-1";
    state.sdkSource = 'export const SDK_VERSION = "1.0.0+build-1";';
    state.readme = "> **Status: `1.0.0+build-1`**";
    state.security = "Prism is stable (`1.0.0+build-1`).";

    const errors = collectReleaseMetadataErrors(state);
    expect(errors).toEqual([
      'SDK publishConfig.tag must be "latest" for version 1.0.0+build-1',
      'CLI publishConfig.tag must be "latest" for version 1.0.0+build-1',
    ]);
  });

  test("release mode requires a dated heading for the exact version", () => {
    const state = validState();
    expect(collectReleaseMetadataErrors(state, { release: true })).toContain(
      `release mode requires a dated CHANGELOG heading for ${VERSION}`,
    );

    state.changelog += `\n## [${VERSION}] - 2026-07-26\n`;
    expect(collectReleaseMetadataErrors(state, { release: true })).toEqual([]);
  });
});
