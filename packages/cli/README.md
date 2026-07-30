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

Generate a Codex implementation DAG from Beads, with Claude or Greptile as
the pull-request review gate:

```console
$ prism beads-dag \
    --repo /path/to/code \
    --beads-repo /path/to/beads \
    --out work.prism.json \
    --reviewer claude \
    --validation-command "npm test"

$ prism run work.prism.json \
    --repo /path/to/code \
    --store runs.db \
    --max-concurrency 4
```

`beads-dag` snapshots each selected Bead into the graph, honors hard dependency
edges, fans out ready implementation nodes, and serializes merge/update nodes
by default. It includes `open`, `in_progress`, and `blocked` work unless
`--all-statuses` or repeatable `--status` filters are supplied. Use repeatable
`--id` and `--label` filters to select work, `--reviewer
greptile|claude|none` to choose the gate, and `--no-merge-nodes`,
`--no-beads-update`, or `--no-serialize-merges` to alter the generated DAG.

Commands: `validate`, `graph`, `beads-dag`, `run` (author & execute); `status`,
`inspect`, `events`, `watch` (observe a persisted run); `resume`, `abort`,
`signal`, `rerun-node` (recover). Graphs may be JSON or YAML. stdout is
machine-readable data (`--json` where noted); diagnostics go to stderr.

Prism executors run real commands (`codex`, `gh`, `bd`, your validation
commands) with no sandbox — see
[SECURITY.md](https://github.com/rsetia/PRism/blob/main/SECURITY.md) before
running graphs you didn't write.

Full documentation: **https://github.com/rsetia/PRism**

MIT
