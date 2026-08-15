# @rsetia/prism

The **Prism** agent-graph SDK: compile a graph of tasks — nodes plus
"depends on" edges — into an immutable plan and run it, dependency-ordered,
with bounded concurrency, failure-classified retry, cooperative cancellation,
durable resume, and a streamed event log.

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
if (!compiled.ok) throw new Error("cannot compile");

const engine = createEngine({
  store: createMemoryStore(),
  registry: createExecutorRegistry(builtinExecutors),
});
const outcome = await engine.run(compiled.graph).result;
// { status: "succeeded", output: "hello" }
```

- Core entry (`@rsetia/prism`) is Node-built-in-free.
- **`@rsetia/prism/node`** adds subprocess/codex executors, git worktrees,
  a SQLite store, artifacts, and logs.
- **`@rsetia/prism/testing`** exports the Vitest `runStoreContract` suite for
  validating third-party `RunStore` adapters and
  `runArtifactStoreContract` / `runLogBackendContract` for artifact and log
  backends, plus `runExecutionBackendContract` and
  `runWorkspaceProvisionerContract` for workers and isolated workspaces.
- Failures are data; node lifecycle events and terminal outcomes are durable;
  resume replays unfinished work and returns the recorded result for finished
  work.

```ts
import { runStoreContract } from "@rsetia/prism/testing";
import { createPostgresStore } from "./postgres-store.js";

runStoreContract("PostgresRunStore", async () => createPostgresStore());
```

The factory receives a clean test lifecycle: it returns a fresh empty store,
and the suite calls its optional `close()` method after each test. Install
`vitest` as a development dependency to use the testing entry point.

Artifact adapters implement `ArtifactStore` from the core entry. Use a fresh
test namespace for each contract case:

```ts
import { runArtifactStoreContract } from "@rsetia/prism/testing";
import { createS3ArtifactStore } from "./s3-artifact-store.js";

runArtifactStoreContract("S3ArtifactStore", async () =>
  createS3ArtifactStore({ prefix: crypto.randomUUID() }),
);
```

Log adapters implement `LogBackend` from the core entry. The contract covers
snapshot reads, ordered writes, and live follow streams:

```ts
import { runLogBackendContract } from "@rsetia/prism/testing";
import { createCloudLogBackend } from "./cloud-log-backend.js";

runLogBackendContract("CloudLogBackend", async () =>
  createCloudLogBackend({ namespace: crypto.randomUUID() }),
);
```

Execution adapters implement `ExecutionBackend` from `@rsetia/prism/node`.
Handles use a backend-defined opaque `id`; the local backend's `nodeDir` is
optional:

```ts
import { runExecutionBackendContract } from "@rsetia/prism/testing";
import { createKubernetesExecutionBackend } from "./kubernetes-execution.js";

runExecutionBackendContract("KubernetesExecutionBackend", async () =>
  createKubernetesExecutionBackend({ namespace: crypto.randomUUID() }),
);
```

The default scenarios require a test worker supporting `echo`, `fail`, and
`stall` config modes. Pass custom `ExecutionBackendContractScenarios` through
the third argument's `scenarios` option when a worker image uses a different
protocol.

Workspace adapters implement `WorkspaceProvisioner` from
`@rsetia/prism/node`. Handles must expose an absolute writable local directory,
including when the actual workspace is containerized or remotely synchronized:

```ts
import { runWorkspaceProvisionerContract } from "@rsetia/prism/testing";
import { createContainerWorkspaceProvisioner } from "./container-workspaces.js";

runWorkspaceProvisionerContract("ContainerWorkspaceProvisioner", async () =>
  createContainerWorkspaceProvisioner(),
);
```

Agent-backed executors require an explicit host policy. `createCodexEngine()`
and `createLocalExecutionBackend()` default to isolated environment handling:
only `PATH` and Prism's protocol variable are inherited. Allowlist ordinary
variables and mark credentials for redaction at the host boundary:

```ts
const engine = createCodexEngine({
  executionPolicy: {
    mode: "isolated",
    environment: {
      inherit: ["PATH", "LANG"],
      values: { SCOPED_GITHUB_TOKEN: await issueScopedToken() },
      secretNames: ["SCOPED_GITHUB_TOKEN"],
    },
  },
});
```

`inherit: "all"` and Codex sandbox bypass are accepted only in
`trusted-local` mode. The bundled CLI selects that compatibility mode for its
local Git/GitHub workflow. Environment isolation is not filesystem or network
containment: production adapters should advertise `isolation: "isolated"` and
run the worker in a container, pod, or VM. See
[SECURITY.md](https://github.com/rsetia/PRism/blob/main/SECURITY.md) for the
complete trust model.

Full docs, the CLI, and the Beads integration:
**https://github.com/rsetia/PRism**

MIT
