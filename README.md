# Prism

Turn a project discussion into parallel implementation work: Codex implements
each Bead in an isolated Git worktree, Claude reviews the pull requests, and
Prism respects the dependency DAG.

## Run a project in one minute

### 1. Set up Prism once

Prism is not published to npm yet. Build the CLI and put it on your path:

```sh
git clone git@github.com:rsetia/PRism.git
cd PRism
npm install
npm run build
npm link --workspace packages/cli
```

Choose one absolute directory for Prism's Beads, run state, worktrees, and
logs. Add this to your shell profile:

```sh
export PRISM_HOME="$HOME/.prism"
```

### 2. Plan with your agent

Have the normal product or engineering discussion first. Then send your agent:

```text
Use the prism-plan-project skill from <PRISM checkout>/skills/prism-plan-project/SKILL.md
to turn this discussion into Beads and an executable Prism DAG. Use Codex to
implement and Claude to review with the exact comment "@claude review".
```

The skill inspects the repository, proposes the work, creates the Beads,
constructs the dependency DAG, validates it, and reports the graph path. It
does not start the run without your approval.

### 3. Run and monitor

From the project repository:

```sh
prism run <graph-file>
```

While it runs, use another terminal in the same repository:

```sh
prism watch
prism logs
```

That is the complete default workflow. No repository, store, run ID, or
concurrency flags are required. `watch` selects the newest unfinished run;
`logs` follows every worker from the newest run, attaches as new nodes start,
and exits when the run finishes. Prism runs up to four ready nodes concurrently
and generates a durable run ID automatically.

## Where Prism stores data

The current Git root determines `<project>`:

```text
$PRISM_HOME/
├── beads/<project>/
├── store/<project>/runs.db
├── worktrees/<project>/
└── logs/<project>/
```

Explicit flags remain available when you need to override these defaults.

## CLI reference

```sh
prism beads-dag --out <graph-file> [--reviewer claude|greptile|none]
prism validate <graph-file>
prism graph <graph-file>
prism run <graph-file> [--max-concurrency <n>]

prism watch [<run-id>]
prism logs [<run-id>]
prism status
prism inspect <run-id>
prism events <run-id>

prism resume <run-id>
prism abort <run-id>
prism signal <run-id> <node-id>
prism rerun-node <run-id> <node-id>
```

Graphs may be JSON or YAML. `--store`, `--repo`, `--beads-repo`,
`--worktree-dir`, and `--run-id` are optional overrides. Add `--json` to
commands that support structured output.

### Exit codes

| Code | Meaning                                     |
| ---- | ------------------------------------------- |
| 0    | Success                                     |
| 1    | The graph ran and failed — a normal outcome |
| 2    | Invalid input or usage                      |
| 3    | Unexpected internal error                   |

> **Status: `0.1.0-alpha.0` — unpublished.** The runtime and CLI are built and
> tested, but public APIs may still change. This is the TypeScript successor
> to the original Python PRism.

## SDK

The CLI is a thin consumer of the SDK; everything it does is possible
programmatically.

```js
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  parseGraph,
} from "@rsetia/prism";

const parsed = parseGraph({
  version: 1,
  nodes: {
    first: { executor: "constant", config: { value: "hello" } },
    second: { executor: "passthrough", dependsOn: ["first"] },
  },
  finalNode: "second",
});
if (!parsed.ok) throw new Error("invalid graph");

const compiled = compileGraph(parsed.graph);
if (!compiled.ok) throw new Error("graph cannot compile");

const engine = createEngine({
  store: createMemoryStore(),
  registry: createExecutorRegistry(builtinExecutors),
  maxConcurrency: 2,
});

const handle = engine.run(compiled.graph);
for await (const event of handle.events) {
  console.error(event.seq, event.kind, event.nodeId);
}
const outcome = await handle.result;
// { status: "succeeded", output: "hello" }
// | { status: "failed", failures: [{ nodeId, cause, failureClass? }] }
// | { status: "cancelled", reason, failures }
```

Model notes:

- **Failures are data.** A failing node resolves the run as `failed` (root
  causes only; downstream nodes show as `blocked`). `result` rejects only for
  engine bugs or invalid API use, never for an expected failure.
- **Lifecycle events are durable facts.** Every node-state change is an event
  with a monotonic sequence number; `handle.events` is a cursor over the
  persisted log, so late subscribers see full history. The terminal run
  outcome is persisted alongside that log, including failures that happen
  before a node starts.
- **Retry is failure-classified.** Executors classify their own failures
  (`transient_infra`, `timeout`, `semantic_failed`, …); the retry policy
  decides per class, with backoff on an injected clock.
- **Durable & resumable.** `createSqliteStore({ path })` from
  `@rsetia/prism/node` persists runs; `engine.resume(runId)` continues one
  after a crash.
- **Custom executors** are `{ name, execute(context) }` returning
  `{ status: "succeeded", output }` or `{ status: "failed", cause,
failureClass? }`. Outputs and failure causes must be JSON-safe so they can be
  persisted; invalid extension results become classified failures. Anything
  thrown is caught and normalized.

### Custom stores

Storage adapters implement the `RunStore` interface. Prism ships the same
Vitest conformance suite used by its memory and SQLite implementations so an
adapter can prove compatible behavior:

```ts
import { runStoreContract } from "@rsetia/prism/testing";
import { createPostgresStore } from "./postgres-store.js";

runStoreContract("PostgresRunStore", async () => {
  return createPostgresStore({ connectionString: process.env.DATABASE_URL });
});
```

The factory must return a fresh, empty store for each test. It may be
asynchronous, and the suite calls the optional `close()` method afterward.
Install `vitest` as a development dependency to use this entry point.

### Custom artifact stores

Remote artifact adapters implement the core `ArtifactStore` interface and can
use the backend-neutral suite exported from the same testing entry point:

```ts
import type { ArtifactStore } from "@rsetia/prism";
import { runArtifactStoreContract } from "@rsetia/prism/testing";
import { createS3ArtifactStore } from "./s3-artifact-store.js";

runArtifactStoreContract("S3ArtifactStore", async () => {
  const store: ArtifactStore = createS3ArtifactStore({
    bucket: "prism-test",
    prefix: crypto.randomUUID(),
  });
  return store;
});
```

The contract checks byte and metadata round-trips, immutable snapshots,
attempt and namespace isolation, listing, logical-name safety, and unknown
artifacts. Backend-specific security and lifecycle tests still belong with the
adapter.

### Custom log backends

Streaming log adapters implement the core `LogBackend` interface. The public
contract covers both snapshot reads and live followers:

```ts
import type { LogBackend } from "@rsetia/prism";
import { runLogBackendContract } from "@rsetia/prism/testing";
import { createCloudLogBackend } from "./cloud-log-backend.js";

runLogBackendContract("CloudLogBackend", async () => {
  const backend: LogBackend = createCloudLogBackend({
    namespace: crypto.randomUUID(),
  });
  return backend;
});
```

The suite checks ordered and concurrent writes, exclusive writers, target and
attempt isolation, independent followers, cancellation, close behavior,
missing logs, and UTF-8 text spanning read-buffer boundaries. Follow chunk
boundaries remain intentionally unspecified.

### Custom execution backends

Process, container, and cluster adapters implement `ExecutionBackend` from the
Node entry. A worker handle has a backend-defined opaque `id`; `nodeDir` is an
optional detail exposed by the local file-protocol backend, not a portability
requirement:

```ts
import type { ExecutionBackend } from "@rsetia/prism/node";
import { runExecutionBackendContract } from "@rsetia/prism/testing";
import { createKubernetesExecutionBackend } from "./kubernetes-execution.js";

runExecutionBackendContract("KubernetesExecutionBackend", async () => {
  const backend: ExecutionBackend = createKubernetesExecutionBackend({
    namespace: crypto.randomUUID(),
  });
  return backend;
});
```

The default scenarios expect a test worker that supports `echo`, `fail`, and
`stall` modes in its `WorkerSpec.config`. Adapters may instead pass custom
`ExecutionBackendContractScenarios` in the third argument's `scenarios`
option, along with a larger `timeoutMs` for slower platforms. The contract
checks result collection, classified failures, status and liveness
transitions, idempotent termination, worker isolation, unknown handles,
cleanup, and the optional `close()` lifecycle. Platform-specific scheduling,
authentication, logs, and orphan-reaping tests remain the adapter's
responsibility.

### Custom workspace provisioners

Workspace adapters implement `WorkspaceProvisioner` from the Node entry.
Every handle exposes an absolute, writable local directory, so container or
remote implementations must mount or synchronize their workspace locally:

```ts
import type { WorkspaceProvisioner } from "@rsetia/prism/node";
import { runWorkspaceProvisionerContract } from "@rsetia/prism/testing";
import { createContainerWorkspaceProvisioner } from "./container-workspaces.js";

runWorkspaceProvisionerContract("ContainerWorkspaceProvisioner", async () => {
  const provisioner: WorkspaceProvisioner =
    createContainerWorkspaceProvisioner();
  return provisioner;
});
```

The contract checks writable absolute directories, attempt and identifier
isolation, case and Unicode identity, input validation, teardown, and
idempotent release. Backend-specific checkout, mount, and failure-cleanup
tests remain the adapter's responsibility.

### Built-in executors

| Name          | Behavior                                                   |
| ------------- | ---------------------------------------------------------- |
| `constant`    | Returns `config.value`; ignores inputs                     |
| `passthrough` | Returns its single input                                   |
| `concat`      | Joins string inputs with `config.separator` (default `""`) |
| `fail`        | Always fails, with `config` as the cause                   |

### Node-only executors — `@rsetia/prism/node`

Everything that touches the filesystem or spawns processes lives behind a
separate entry point, so a core-only consumer never loads Node built-ins:

- `createLocalExecutionBackend` / `createGitWorktreeProvisioner` /
  `createSubprocessExecutor` — run a node as a supervised subprocess in an
  isolated git worktree, with heartbeat liveness and idle-timeout.
- `createCodexEngine` / `createCodexExecutor` — run a coding agent
  (`codex exec`) that implements a work item, opens/updates a PR, and drives a
  review loop (Greptile or Claude) to merge-readiness.
- `createMergePrExecutor` / `createBeadsUpdateExecutor` — deterministic `gh` /
  `bd` operations.
- `createLocalArtifactStore` / `createFileLogBackend` — worker artifacts (by
  URI) and streamable logs.

### Beads integration

`buildBeadsGraph(parseBeadsJsonl(bdJsonl))` turns a
[Beads](https://github.com/steveyegge/beads) backlog (`bd list --json`) into a
runnable graph: one `implement` node per bead, wired by bead dependencies,
with `merge_resolve` and `beads_update` follow-ups. Each implementation gets
the full snapshotted bead record—including its description and acceptance
criteria—as its first input.

## Security

Prism executors run real commands — `codex`, `gh`, `bd`, and your configured
validation commands — **as you, with no sandbox.** Graph and config files are
treated as untrusted _data_ (validated before use), but configured commands
are treated as _trusted code_. **Do not run graphs from sources you don't
trust.** See [SECURITY.md](SECURITY.md) for the full trust model.

## Status & limitations

Built and tested: the graph compiler, the concurrent engine (retry,
cancellation), the durable SQLite store with resume, the subprocess/codex
worker protocol with worktrees/artifacts/logs, every executor a Beads graph
names, and the operator CLI above.

Deliberately **not** included:

- **Typed dataflow** — node outputs are JSON values, but there is no
  compile-time wiring between the shape produced by one node and the shape
  expected by another yet.
- **`kill-stale`** — reaping orphaned worker OS processes needs worker-PID
  persistence tied to a specific execution backend, out of scope for the
  backend-agnostic core. `abort` covers the state-recovery half.
- **Distributed scheduling, a browser UI, remote artifact storage.**

## Development

```sh
npm install
npm run verify
```

`verify` is the definition of green: aligned release metadata, build,
type-check (including tests), type-aware lint, format check, the full test
suite (unit, exhaustive state-table, store-contract, spawned-CLI integration,
real-subprocess and real-git integration, tarball contents), `publint` +
`@arethetypeswrong/cli`, npm publish dry runs, and a packed-tarball consumer
smoke test. CI runs the same command.

Release history is recorded in [CHANGELOG.md](CHANGELOG.md). Maintainers use
the non-publishing checks and procedure in [RELEASING.md](RELEASING.md);
contributors add user-visible changes under `Unreleased` without bumping
package versions.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for
the development workflow and extension contracts. Participation follows the
[Code of Conduct](CODE_OF_CONDUCT.md); project decisions and support
expectations are documented in [GOVERNANCE.md](GOVERNANCE.md) and
[SUPPORT.md](SUPPORT.md).

## License

[MIT](LICENSE)
