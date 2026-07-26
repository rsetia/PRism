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
  `runArtifactStoreContract` for artifact backends.
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

Executors run real commands with no sandbox — see the repository's
[SECURITY.md](https://github.com/rsetia/PRism/blob/main/SECURITY.md) before
running untrusted graphs.

Full docs, the CLI, and the Beads integration:
**https://github.com/rsetia/PRism**

MIT
