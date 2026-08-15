# Prism

Turn a project discussion into parallel implementation work. Codex implements
each task, Greptile reviews the pull requests, and Prism follows the dependency
DAG.

## Set up once

Prism is not published to npm yet:

```sh
git clone git@github.com:rsetia/PRism.git
cd PRism
npm install
npm run build
npm link --workspace packages/cli
```

Choose one absolute directory for all Prism data and add it to your shell
profile:

```sh
export PRISM_HOME="$HOME/.prism"
```

Install the planning skill so your agent can find it:

```sh
prism skills install
```

That copies `prism-plan-project` into `~/.claude/skills/`. Use `--agent codex`
for `~/.codex/skills/`, or `--project` to commit it to the repository you are
planning. Restart the agent session afterwards.

## Plan with your agent

First, have the normal product or engineering discussion about your project.
Then ask, in plain language:

```text
Turn this discussion into Beads and an executable Prism DAG. Use Codex to
implement and Greptile to review with the exact comment "@greptile review".
```

The installed skill matches on its own description, so there is no path to
paste. It creates the Beads, initializes a remote integration branch, builds
and validates the DAG, and gives you the graph path. It does not start the run.

If your agent does not support skills, point it at the file directly — run
`prism skills list --json` to get the installed path.

## Run

From your project repository:

```sh
prism run <graph-file>
```

Codex-backed nodes use `gpt-5.6-terra` with `medium` reasoning by default.
Override either setting for a run or resume with `--codex-model <id>` and
`--codex-reasoning-effort <level>`.

If both production and staging Greptile apps review the same pull requests,
select the production GitHub App for the whole run:

```sh
prism run <graph-file> --greptile-app-slug greptile-apps
```

The selector applies to every Greptile `implement` node and is persisted with
the run, so a later `prism resume <run-id>` keeps the same policy without the
flag. A graph can also bake in the selector when it is generated with
`prism beads-dag ... --greptile-app-slug greptile-apps`. Omitting the selector
preserves the normal broad Greptile behavior.

In another terminal, view the live DAG:

```sh
prism watch
```

Follow the implementer logs:

```sh
prism logs
```

That is the complete workflow. Prism uses the current Git repository, creates
a run ID automatically, and runs up to four ready tasks in parallel.

## Data

Prism keeps each project's data under `PRISM_HOME`:

```text
$PRISM_HOME/
├── beads/<project>/
├── store/<project>/runs.db
├── worktrees/<project>/
└── logs/<project>/
```

## Useful commands

```sh
prism skills list
prism status
prism inspect <run-id>
prism resume <run-id>
prism abort <run-id>
prism rerun-node <run-id> <node-id>
prism --help
```

`prism inspect` reports per-node phase durations, total elapsed time, the
weighted DAG critical path, resource contention, and the largest waiting
categories. Add `--json`
for the versioned machine-readable timing summary.

## Trust

Prism runs Codex, Git, GitHub CLI, Beads, and validation commands as you, with
your network and credentials in its explicit trusted-local compatibility mode.
The SDK also provides an isolated environment policy for production adapters.
Only run trusted-local DAGs you trust.
Greptile app selection is enforced through the Codex worker instructions; it
is not a separate deterministic GitHub review adapter.
See [SECURITY.md](SECURITY.md) for details.

SDK documentation is in [packages/sdk/README.md](packages/sdk/README.md).

Status: `0.1.0-alpha.0` (unpublished).
