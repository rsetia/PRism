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
- Failures are data; events are the source of truth; resume is event replay.

Executors run real commands with no sandbox — see the repository's
[SECURITY.md](https://github.com/rsetia/PRism/blob/main/SECURITY.md) before
running untrusted graphs.

Full docs, the CLI, and the Beads integration:
**https://github.com/rsetia/PRism**

MIT
