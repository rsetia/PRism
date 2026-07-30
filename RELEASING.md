# Releasing Prism

Prism publishes `@rsetia/prism` and `@rsetia/prism-cli` together at one
version. The CLI depends on that exact SDK version. Prereleases use the npm
`next` dist-tag; stable releases use `latest`.

Only maintainers release packages. Contributors should add user-visible
changes to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md), but should
not bump versions.

## Prepare a release

1. Start from an up-to-date, clean `main` branch.
2. Choose one SemVer version for both packages.
3. Update all versioned surfaces:
   - `packages/sdk/package.json`;
   - `packages/cli/package.json`;
   - the CLI's exact `@rsetia/prism` dependency;
   - `SDK_VERSION` in `packages/sdk/src/index.ts`;
   - the status version in `README.md` and `SECURITY.md`;
   - `publishConfig.tag` (`next` for a prerelease, `latest` for a stable
     release).
4. Run `npm install --package-lock-only --ignore-scripts` to update the
   workspace entries in `package-lock.json`.
5. Move the accumulated changelog entries under
   `## [VERSION] - YYYY-MM-DD`, then restore an empty `## [Unreleased]`
   section above it.
6. Run:

   ```sh
   npm run audit
   npm run verify
   ```

7. Review `npm pack --dry-run --json --workspace @rsetia/prism` and
   `npm pack --dry-run --json --workspace @rsetia/prism-cli`, then commit the
   release preparation as `chore: release vVERSION`.

`npm run version:check` is part of `verify`. It rejects mismatched manifests,
lockfile entries, source and documentation versions, changelog structure, or
unsafe npm publishing metadata. `npm run publish:check` packs both workspaces
and runs non-publishing npm dry runs with the explicit expected dist-tag; it is
also part of `verify`.

## Tag the release candidate

Create an annotated tag only after the release commit is reviewed and merged:

```sh
git tag -a vVERSION -m "Prism vVERSION"
npm run release:check
git push origin vVERSION
```

`release:check` is intentionally non-publishing. In addition to the normal
metadata checks, it requires a clean tree, a dated changelog entry for the
exact version, and a matching tag at `HEAD`. It then packs both workspaces and
runs `npm publish --dry-run` against the tarballs with the expected dist-tag
and public access.

## Publishing prerequisites

The repository intentionally has no npm publishing workflow yet. Before the
first registry release:

1. Configure
   [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
   separately for both package names.
2. Add a dedicated, reviewed GitHub Actions release workflow pinned to exact
   action revisions, with only `contents: read` and `id-token: write`.
3. Publish the SDK first and the CLI second from that workflow. Pass
   `--tag next` for prereleases or `--tag latest` for stable releases
   explicitly; do not rely on npm workspace option inheritance.
4. Do not add a long-lived npm token. Trusted publishing supplies short-lived
   credentials and automatically generates
   [provenance](https://docs.npmjs.com/generating-provenance-statements/) for
   public packages.

Both manifests already require the public npm registry, public visibility,
and provenance. A prerelease is also pinned to `next`, preventing an alpha
from becoming the default install.

After publishing, verify the registry metadata and install both packages into
a clean directory before creating the corresponding GitHub release.

## Correcting a bad release

Published package contents and versions are immutable. Do not retag or reuse a
version. Deprecate the affected version in npm when appropriate, prepare a new
patch or prerelease version, document the correction in the changelog, and run
the complete process again.
