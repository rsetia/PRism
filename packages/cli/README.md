# @rsetia/prism-cli

The command-line runner for [**Prism**](https://github.com/rsetia/PRism)
agent graphs. Installs a `prism` binary.

```console
$ prism run graph.json
"hello"

$ prism run graph.json --store runs.db --run-id demo
$ prism status  --store runs.db
demo    finished
$ prism inspect demo --store runs.db
first: succeeded
second: succeeded
finished: true
```

Commands: `validate`, `graph`, `run` (author & execute); `status`, `inspect`,
`events`, `watch` (observe a persisted run); `resume`, `abort`, `signal`,
`rerun-node` (recover). Graphs may be JSON or YAML. stdout is machine-readable
data (`--json` where noted); diagnostics go to stderr.

Prism executors run real commands (`codex`, `gh`, `bd`, your validation
commands) with no sandbox — see
[SECURITY.md](https://github.com/rsetia/PRism/blob/main/SECURITY.md) before
running graphs you didn't write.

Full documentation: **https://github.com/rsetia/PRism**

MIT
