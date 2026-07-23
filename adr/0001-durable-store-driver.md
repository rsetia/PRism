# ADR 0001 — Durable store driver

Status: **accepted**
Date: 2026-07-20

## Context

Section 12 adds a durable `RunStore` so runs survive the process. The
memory store's contract (gapless per-run sequence numbers, atomic
snapshot+events commit, in-process live-follow) is fixed; only the
backing storage changes. We need a SQLite driver for Node.

## Options

1. **`node:sqlite` (builtin `DatabaseSync`)** — no dependency, synchronous
   API, ships with Node. Added in 22.5 (experimental), stabilizing through 24. Emits an experimental warning on older versions. Forces the
   supported-Node floor up.
2. **`better-sqlite3`** — mature, synchronous, widely used. A native
   dependency: prebuilt binaries per platform/Node-ABI, which complicates
   the "core installs nothing heavy" promise and the packaging story.

## Decision

Use **`node:sqlite`**. It keeps the SDK dependency-free, its synchronous
API matches how the memory store already works (wrap sync calls in
resolved promises), and it aligns with the project's "add a dependency
only when writing <50 lines of clear code isn't enough" rule.

Cost: the supported-Node floor rises. Bump `engines.node` to `>=24` and
move CI's version to 24. Record that bump in the same PR that lands the
driver.

If a consumer later needs a Node version without `node:sqlite`, the
`RunStore` port means a `better-sqlite3` adapter is an additive package,
not a rewrite.

## Consequences

- `engines.node` and CI Node version change with §12.
- The durable adapter lives behind the same `RunStore` interface and must
  pass the shared contract suite — no new semantics, only new storage.
- Cross-process live-follow (watching a run from another process) is NOT
  in scope here; the durable store follows live only in-process, the same
  way the memory store does. Cross-process watching is a §16 concern
  (polling), not a store responsibility.
