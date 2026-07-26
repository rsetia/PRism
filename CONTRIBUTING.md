# Contributing to Prism

Thank you for helping improve Prism. The project is an unreleased alpha, so
focused bug fixes, tests, documentation, and well-scoped extension points are
especially valuable.

By submitting a contribution, you confirm that you have the right to submit
it and agree that it will be licensed under the repository's [MIT
License](LICENSE).

## Before starting

- Search existing issues before opening a new one.
- Open an issue before a substantial API, persistence, graph-schema, or
  architectural change. Small fixes do not need advance approval.
- Report vulnerabilities privately using [SECURITY.md](SECURITY.md), not a
  public issue.
- Keep each pull request focused on one independently reviewable change.

## Development setup

Prism requires Node.js 24 or newer.

```sh
git clone https://github.com/rsetia/PRism.git
cd PRism
npm ci
npm run verify
```

`npm run verify` is the required gate. It builds both packages, type-checks,
lints, checks formatting, runs all tests, validates packed package metadata,
and exercises the SDK and CLI from cleanly installed tarballs.

`npm run audit` checks the complete dependency tree for high- and
critical-severity vulnerabilities. CI runs both gates.

Use `npm run dev` for TypeScript watch mode and
`npm exec vitest -- --watch` for an interactive test loop.

## Making a change

1. Add or update a test that demonstrates the behavior.
2. Implement the smallest complete change.
3. Update public documentation when an API, command, security boundary, or
   operational behavior changes.
4. Run `npm run audit` and `npm run verify`.
5. Open a pull request using the repository template.

Tests live beside their package under `packages/*/test`. Prefer externally
observable assertions over private implementation details. New storage or
execution adapters should have a shared contract suite when multiple
implementations must behave identically.

## Extension contracts

Prism is designed to grow through explicit interfaces:

- **Executors:** implement `ExecutorDefinition`, validate configuration during
  preflight, observe `context.signal`, and return JSON-safe output or failure
  data. Register executors explicitly with `createExecutorRegistry`; do not
  introduce global registries.
- **Stores:** implement `RunStore` and preserve its atomic append, gapless
  sequence, terminal-outcome, snapshot, and resume semantics. Run
  `runStoreContract` from `@rsetia/prism/testing` against every implementation.
- **Execution, artifacts, logs, and workspaces:** implement the corresponding
  Node-only port and keep platform behavior out of the core runtime.
- **Core APIs:** `@rsetia/prism` must remain free of Node built-in imports.
  Filesystem, subprocess, SQLite, and Git integrations belong under
  `@rsetia/prism/node`.

Run outcomes and persisted event payloads must remain JSON-safe. Expected
workflow failures are data; thrown errors are reserved for invalid API use,
persistence/platform failures, and invariant violations.

## Compatibility and design decisions

The public API may still change before 1.0, but changes should be deliberate
and documented. Please raise an issue before:

- changing graph schema version 1;
- changing persisted SQLite, artifact, log, or worker-protocol data;
- weakening validation or security boundaries;
- adding a dependency to the core package;
- changing event ordering or resume semantics.

Record architectural decisions with lasting tradeoffs in `adr/`.

## AI-assisted contributions

AI-assisted contributions are welcome. The human contributor remains
responsible for correctness, licensing, security, and understanding every
submitted change. Disclose material AI assistance in the pull request, review
generated code carefully, and never provide repository secrets or private
reports to an unapproved service.

## Conduct and help

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Project decision-making is described in [GOVERNANCE.md](GOVERNANCE.md), and
help channels are listed in [SUPPORT.md](SUPPORT.md).
