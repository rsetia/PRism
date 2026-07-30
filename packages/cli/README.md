# @rsetia/prism-cli

The command-line runner for [**Prism**](https://github.com/rsetia/PRism)
agent graphs. Installs a `prism` binary.

```console
$ prism run graph.json
"hello"

$ export PRISM_HOME="$HOME/2026"
$ prism run graph.json
run run-550e8400-e29b-41d4-a716-446655440000
$ prism status
run-550e8400-e29b-41d4-a716-446655440000    finished
$ prism inspect run-550e8400-e29b-41d4-a716-446655440000
first: succeeded
second: succeeded
finished: true
```

`PRISM_HOME` is a single absolute root for project-scoped defaults:
`beads/<project>/`, `store/<project>/runs.db`, and
`worktrees/<project>/`. Prism derives `<project>` from the current Git root.
Explicit `--repo`, `--beads-repo`, `--store`, and `--worktree-dir` flags
override those defaults. Runs persist under `PRISM_HOME` with a generated ID
and use four-way concurrency by default. Without `PRISM_HOME`, a plain run
remains in-memory.

Generate a Codex implementation DAG from Beads, with Claude or Greptile as
the pull-request review gate:

```console
$ cd /path/to/code
$ prism beads-dag \
    --out work.prism.json \
    --reviewer claude \
    --validation-command "npm test"

$ prism run work.prism.json
# Copy the generated run id printed to stderr:
$ prism watch <run-id>
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
