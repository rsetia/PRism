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
    --out "$PRISM_HOME/store/myproject/work.prism.json" \
    --target-branch prism/myproject-integration \
    --greptile-app-slug greptile-apps \
    --validation-command "npm test" \
    --final-pr-base main \
    --final-pr-reviewer claude \
    --final-pr-validation-command "npm run verify"

$ prism run "$PRISM_HOME/store/myproject/work.prism.json"
$ prism watch
$ prism logs
```

The graph is a generated run artifact — write `--out` under `$PRISM_HOME`, not
into the code repository it is about to modify.

`beads-dag` snapshots each selected Bead into the graph, honors hard dependency
edges, fans out ready implementation nodes, and serializes merge/update nodes
by default. It includes `open`, `in_progress`, and `blocked` work unless
`--all-statuses` or repeatable `--status` filters are supplied. Use repeatable
`--id` and `--label` filters to select work, `--reviewer
greptile|claude|none` to choose the gate, `--greptile-app-slug` to restrict
Greptile feedback to one GitHub App identity, and `--no-merge-nodes`,
`--no-beads-update`, or `--no-serialize-merges` to alter the generated DAG.
By default, merge nodes share a capacity-one `integration-branch` scheduler
resource, so unrelated Beads remain parallel in the dependency DAG while
integration-branch updates run one at a time. `--no-serialize-merges` omits
that resource request.
Add `--final-pr-base <branch>` to append a terminal integration-PR node. It
opens or reuses a pull request from `--target-branch` to that base, runs the
selected reviewer and repeatable `--final-pr-validation-command` checks on the
current head, fixes and pushes actionable findings, and leaves the approved PR
open for a human to merge. Choose its gate with `--final-pr-reviewer
claude|greptile|none`; use `--final-pr-draft` when the final PR should remain a
draft. `--final-pr-base` cannot be combined with `--no-merge-nodes`: without
merge nodes nothing lands on the integration branch to promote. The final PR
gate inherits `--min-confidence-score` and `--review-trigger-comment` when its
reviewer matches `--reviewer`; override the trigger with
`--final-pr-review-trigger-comment`.

The same selector can be applied globally at execution time with
`prism run <graph> --greptile-app-slug greptile-apps`. It covers every
Greptile-gated node, including the final integration PR. Prism rejects the
flag when the graph has no Greptile review nodes or a node selects a
different app. The effective graph is saved in the run store, so `resume`
does not accept or need the flag. Without a selector, existing broad Greptile
review behavior is unchanged. App filtering is enforced by the Codex worker's
review-loop contract, rather than by a separate deterministic reviewer
adapter.

Commands: `skills` (install the planning skill); `validate`, `graph`,
`beads-dag`, `run` (author and execute);
`status`, `inspect`, `events`, `watch`, `logs` (observe); `resume`, `abort`,
`signal`, `rerun-node` (recover). Graphs may be JSON or YAML.
`inspect` includes phase durations, elapsed time, resource-contention waits,
the weighted critical path,
and largest waits; `inspect --json` exposes the same timing data for tools.

Codex-backed nodes default to `gpt-5.6-terra` with `medium` reasoning. Both
`run` and `resume` accept `--codex-model <id>` and
`--codex-reasoning-effort <level>` overrides.

Prism executors run real commands (`codex`, `gh`, `bd`, your validation
commands) with no sandbox — see
[SECURITY.md](https://github.com/rsetia/PRism/blob/main/SECURITY.md) before
running graphs you didn't write.

`npm run eval` at the repository root validates orchestration with fake or
recorded backends only. Live Codex/GitHub smoke testing is opt-in and is not a
public CI requirement.

Full documentation: **https://github.com/rsetia/PRism**

MIT
