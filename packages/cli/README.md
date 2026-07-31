# @rsetia/prism-cli

The command-line runner for [**Prism**](https://github.com/rsetia/PRism)
agent graphs. Installs a `prism` binary.

Set one home, then run from your project repository:

```console
$ export PRISM_HOME="$HOME/.prism"
$ prism run work.prism.json
```

In another terminal:

```console
$ prism watch
$ prism logs
```

Prism derives the project from the current Git root. Runs persist with a
generated ID and use four-way concurrency by default. `watch` selects the
newest unfinished run and renders its live dependency DAG with highlighted
node states. `logs` follows all worker output from the newest run until it
finishes. Explicit path, run ID, and concurrency flags remain available as
overrides. Redirected and `--json` watch output remain script-friendly.

## Plan with your agent

The package bundles an agent skill, `prism-plan-project`, that turns a product
or engineering discussion into a Beads backlog and an executable DAG. Install
it once so your agent discovers it by itself:

```console
$ prism skills install
$ prism skills list
```

`install` copies into `~/.claude/skills/` by default. `--agent codex` targets
`~/.codex/skills/`, `--project` writes into the current repository, and
`--force` overwrites an existing copy. Restart the agent session afterwards,
then ask it to plan the project in plain language — the skill matches on its
own description, so no path needs pasting.

`beads-dag` below is the compiler that skill drives. Use it directly only when
the work items and dependencies already exist.

Generate a Codex implementation DAG from Beads. Greptile review with the
trigger `@greptile review` is the default:

```console
$ cd /path/to/code
$ prism beads-dag \
    --out work.prism.json \
    --validation-command "npm test"

$ prism run work.prism.json
$ prism watch
$ prism logs
```

`beads-dag` snapshots each selected Bead into the graph, honors hard dependency
edges, fans out ready implementation nodes, and serializes merge/update nodes
by default. It includes `open`, `in_progress`, and `blocked` work unless
`--all-statuses` or repeatable `--status` filters are supplied. Use repeatable
`--id` and `--label` filters to select work, `--reviewer
greptile|claude|none` to choose the gate, and `--no-merge-nodes`,
`--no-beads-update`, or `--no-serialize-merges` to alter the generated DAG.

Commands: `skills` (install the planning skill); `validate`, `graph`,
`beads-dag`, `run` (author and execute);
`status`, `inspect`, `events`, `watch`, `logs` (observe); `resume`, `abort`,
`signal`, `rerun-node` (recover). Graphs may be JSON or YAML.

Prism executors run real commands (`codex`, `gh`, `bd`, your validation
commands) with no sandbox — see
[SECURITY.md](https://github.com/rsetia/PRism/blob/main/SECURITY.md) before
running graphs you didn't write.

Full documentation: **https://github.com/rsetia/PRism**

MIT
