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

## Plan with your agent

First, have the normal product or engineering discussion about your project.
Then tell your agent:

```text
Read <PRISM checkout>/skills/prism-plan-project/SKILL.md and use it to turn
this discussion into Beads and an executable Prism DAG. Use Codex to implement
and Greptile to review with the exact comment "@greptile review".
```

The skill creates the Beads and DAG, validates them, and gives you the graph
path. It does not start the run.

## Run

From your project repository:

```sh
prism run <graph-file>
```

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
prism status
prism inspect <run-id>
prism resume <run-id>
prism abort <run-id>
prism rerun-node <run-id> <node-id>
prism --help
```

## Trust

Prism runs Codex, Git, GitHub CLI, Beads, and validation commands as you, with
your network and credentials and without a sandbox. Only run DAGs you trust.
See [SECURITY.md](SECURITY.md) for details.

SDK documentation is in [packages/sdk/README.md](packages/sdk/README.md).
Release history is in [CHANGELOG.md](CHANGELOG.md).

Status: `0.1.0-alpha.0` (unpublished).
