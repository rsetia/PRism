# Changelog

All notable changes to Prism are recorded here. The project follows
[Semantic Versioning](https://semver.org/); prerelease APIs may still change
before 1.0.

## [Unreleased]

### Added

- A versioned graph compiler and concurrent execution engine with durable
  outcomes, retries, cancellation, resume, and streamed events.
- Node-only SQLite, subprocess, Git worktree, artifact, log, Codex, and
  command-line integrations.
- Public Vitest conformance suites for run stores, artifact stores, log
  backends, execution backends, and workspace provisioners.
- OSS governance, contribution, support, security, and dependency-maintenance
  policies.

### Changed

- Core and Node-only exports are separated so browser-compatible consumers do
  not load Node built-ins.
- Execution backend handles use a backend-defined opaque identity; the local
  protocol directory is optional.

### Fixed

- Durable run outcomes now survive resume and process restarts.
- Filesystem and Git identifiers use collision-resistant reversible encoding.
