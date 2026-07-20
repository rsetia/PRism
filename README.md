# agent-graph

A TypeScript SDK for defining, validating, compiling, and running dependency
graphs of tasks — plus a CLI that consumes only the SDK's public API.

A graph is JSON: nodes, each naming an **executor** (the code that runs it)
and the nodes it **depends on**. The SDK validates the graph, compiles it
into an immutable plan (cycle detection, stable topological order), and
executes it — dependency-ordered, with bounded concurrency, structured
events, and failures as data.

> **Status: `0.1.0-alpha.0`** — not yet published to npm. Public function
> shapes are frozen for the alpha but will evolve before `0.1.0`. See
> [Alpha limitations](#alpha-limitations).

_This repository (PRism) is a TypeScript rebuild; the original Python PRism
serves as a behavioral reference, not a porting source._

## Quickstart

```sh
git clone git@github.com:rsetia/PRism.git && cd PRism
npm install
npm run build
alias agent-graph="node $PWD/packages/cli/dist/main.js"
```

(Or `npm pack` both packages and install the tarballs anywhere — the bin is
wired as `agent-graph`.)

The example graph, [`examples/hello.json`](examples/hello.json):

```json
{
  "version": 1,
  "nodes": {
    "first": { "executor": "constant", "config": { "value": "hello" } },
    "second": { "executor": "passthrough", "dependsOn": ["first"] }
  },
  "finalNode": "second"
}
```

### The three commands

**Validate** — exit `0` if the graph is valid; structured errors
(`error <CODE> {...}`) on stderr if not:

```sh
agent-graph validate examples/hello.json
```

**Graph** — print the compiled plan (add `--json` for machine output):

```console
$ agent-graph graph examples/hello.json
first (constant)
second (passthrough) <- first
final: second
```

**Run** — execute with the built-in executors:

```console
$ agent-graph run examples/hello.json
"hello"

$ agent-graph run examples/hello.json --json
{"version":1,"status":"succeeded","output":"hello"}
```

`--json` output is versioned, one line, and free of decoration. stdout only
ever carries data — human diagnostics go to stderr — so everything pipes
cleanly.

### Exit codes

| Code | Meaning                                     |
| ---- | ------------------------------------------- |
| 0    | Success                                     |
| 1    | The graph ran and failed — a normal outcome |
| 2    | Invalid input or usage                      |
| 3    | Unexpected internal error                   |

## Using the SDK

```js
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  parseGraph,
} from "@rsetia/agent-graph";

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
// or { status: "failed", failures: [{ nodeId, cause }] }
```

Notes on the model:

- **Failures are data.** A failing node resolves the run as
  `{ status: "failed", failures }` listing root causes only (downstream
  nodes show as `blocked`). `result` rejects only for engine bugs or
  invalid API use.
- **Events are the source of truth.** Every state change is an event with
  a monotonic sequence number; `handle.events` is a cursor over the
  persisted log, so late subscribers see the full history and iterating
  twice works.
- **Dependencies are ordered inputs.** A node's `dependsOn` array is also
  the order its inputs arrive in.
- **Custom executors** are `{ name, execute(context) }` returning
  `{ status: "succeeded", output }` or `{ status: "failed", cause }`;
  anything thrown is caught and normalized into a failure.

### Built-in executors

| Name          | Behavior                                                   |
| ------------- | ---------------------------------------------------------- |
| `constant`    | Returns `config.value`; ignores inputs                     |
| `passthrough` | Returns its single input                                   |
| `concat`      | Joins string inputs with `config.separator` (default `""`) |
| `fail`        | Always fails, with `config` as the cause                   |

## Alpha limitations

Deliberately absent from `0.1.0-alpha.0`, in rough order of what comes next:

- **Typed dataflow** — node outputs are `unknown`; no compile-time wiring
  types yet.
- **Cancellation and retries.**
- **Durable storage and resume** — the only store is in-memory.
- **Subprocess or shell executors** — the built-ins are pure functions.
- **CLI `inspect` / `cancel` / `events` / `resume` commands.**

## Development

```sh
npm install
npm run verify
```

`verify` is the definition of green: typecheck + build, type-aware lint,
format check, the full test suite (unit, exhaustive state-table, store
contract, spawned-CLI integration, tarball contents), `publint` +
`@arethetypeswrong/cli`, and a packed-tarball consumer smoke test (plain-JS
import, strict TS compile, packed CLI run). CI runs exactly the same
command.

## License

[MIT](LICENSE)
