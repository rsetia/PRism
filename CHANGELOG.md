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
- CLI Beads-to-DAG generation with parallel Codex implementation, configurable
  Claude or Greptile review gates, serialized merges, and Beads updates.
- Public Vitest conformance suites for run stores, artifact stores, log
  backends, execution backends, and workspace provisioners.
- OSS governance, contribution, support, security, and dependency-maintenance
  policies.

### Changed

- Core and Node-only exports are separated so browser-compatible consumers do
  not load Node built-ins.
- Execution backend handles use a backend-defined opaque identity; the local
  protocol directory is optional.
- `PRISM_HOME` now supplies project-scoped defaults for Beads workspaces,
  durable run stores, agent worktrees, and worker logs; repository paths
  default to the current git root. CLI runs persist with generated IDs when
  this home is configured, and agent execution defaults to four-way
  concurrency.
- `prism watch` and `prism logs` default to the current project's latest run;
  Codex worker output is captured durably, and `logs` follows every worker
  until the run finishes.
- Interactive `prism watch` redraws the dependency DAG as execution advances,
  with high-contrast state highlighting and progress; redirected output keeps
  its stable line-oriented format.
- Generated Beads DAGs default to Greptile review with the exact trigger
  comment `@greptile review` and a strict latest-current-head 5/5 confidence
  gate; Claude and no-review workflows remain explicit overrides.
- Claude review gates infer merge readiness from the latest substantive
  current-head Claude response, so an unambiguous “looks good” comment can
  satisfy the gate without a formal GitHub approval object.
- The project-planning skill now creates and records an explicit remote
  integration branch, passes it through `--target-branch`, and hands off the
  final integration-to-base pull request.

### Fixed

- Durable run outcomes now survive resume and process restarts.
- Filesystem and Git identifiers use collision-resistant reversible encoding.
- Codex implementation and merge workers again inherit trusted host GitHub
  access, matching Prism's documented trust model and the original prism-py
  behavior; failed attempts retain their local branches for recovery.
