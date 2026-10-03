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
A session that goes 30 minutes without output or a phase change is terminated
as stalled and retried or continued from its pull request;
`--codex-stall-timeout-minutes <n>` changes the limit (0 disables).

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

## Poll

Instead of a planned DAG, Prism can watch a source and implement work as it
appears. Linear is the first source:

```sh
export LINEAR_API_KEY=lin_api_...   # https://linear.app/settings/account/security
prism poll examples/linear-poll.yaml
```

Every `intervalSeconds`, the poller asks Linear for issues that match the
config: the trigger label, a backlog or unstarted state, assigned to you, and
the label applied by you. Anyone in a workspace can add a label, and
implementers run with your credentials, so by default a label a teammate
applied is skipped and logged. Issues blocked by unfinished work wait until
the blocker closes.

Each newly matching issue is queued once. Prism snapshots the issue, with its
description, comments, relations, and attachments, into a context node. It
then adds an `implement` node that works on Linear's suggested branch and
loops with Greptile until the review gate passes. The default gate is a final
5/5 with no actionable findings and green checks. Nothing merges: a finished
implementer leaves a pull request ready for your review. `maxParallel` caps
how many implementers run at once, and the rest wait their turn.
Prism does not move issues in Linear: completed items can keep matching until
you change their state or label, but deduplication prevents another implementation.

The poll run is durable and named after the config (`poll-<name>`), so
`prism watch` follows it like any other run and shows what is being watched,
how often, and where each queued issue stands. Stopping the poller and
starting it again resumes the same run: queued issues are not queued twice,
and interrupted implementers pick up their existing branch and pull request.
A restart right after a crash waits for the old poller's leases to lapse,
about 30 seconds. Editing the config does not change a running poll; start a
new one with `--run-id` to apply it.

A failed item stays failed until you retry it. Stop the poller, reset the
item's implementer, and start the poller again:

```sh
prism signal poll-agent-implemented implement-linear-eng-2142
prism poll examples/linear-poll.yaml
```

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
prism stats [<run-id>...] [--all]
prism resume <run-id>
prism abort <run-id>
prism rerun-node <run-id> <node-id>
prism rerun-node <run-id> <node-id> --refresh [--spec-file <path>]
prism --help
```

`rerun-node --refresh` re-reads a failed node's Bead (and, with
`--spec-file`, a new frozen spec) and records it in the same run as an
audited graph revision before re-running the node, so a blocked worker can
continue with corrected task text instead of a new run. Ids, dependencies,
review and target settings never change, and nodes that succeeded or are
running cannot be refreshed. Live runs apply it in place; finished runs are
reopened for `prism resume`.

`prism inspect` reports per-node phase durations, total elapsed time, the
weighted DAG critical path, resource contention, and the largest waiting
categories. Add `--json`
for the versioned machine-readable timing summary.

`prism stats` answers what made a run take as long as it did. It walks the
realized critical path back from the last node to succeed (always taking the
dependency that finished last) and splits that path's time by phase, then
lists every phase's interval count, median, p90, and total; review rounds
per node (entries into `review_wait`); idle stretches when no worker was
running, with the event that ended each one (usually an operator reset); and
failed/reset/blocked counts and direct versus agent merges. With no run id
it reports the latest run; `--all` reports every run oldest first, followed
by totals across them, which is the before/after view for a change to the
orchestrator. Time is measured up to a run's last event, so a live run's
current wait is not yet counted. Events recorded before timestamps existed
are skipped. The
same numbers are available from `readRunStats` and `computeRunStats` in the
SDK, and as JSON with `--json`.

## Trust

Prism runs Codex, Git, GitHub CLI, Beads, and validation commands as you, with
your network and credentials in its explicit trusted-local compatibility mode.
The SDK also provides an isolated environment policy for production adapters.
Only run trusted-local DAGs and poll configs you trust. A poll config can set
validation commands and `source.apiUrl`; the latter receives your Linear token
and defaults to `https://api.linear.app/graphql`. Only override it for an endpoint
you control (such as a local test server).
The label-applier check authorizes the trigger, not the issue's contents:
descriptions, comments, and attachments from other workspace members also reach
the implementer. Review that content before applying the trigger label, and keep
`labelAppliedBy: me` unless you trust everyone who can label issues.
`LINEAR_API_KEY` accepts a personal API key as shown above; for OAuth, provide the
full `Bearer <access-token>` authorization value in the configured token variable.
Greptile app selection is enforced through the Codex worker instructions; it
is not a separate deterministic GitHub review adapter.
See [SECURITY.md](SECURITY.md) for details.

SDK documentation is in [packages/sdk/README.md](packages/sdk/README.md).

## Release validation

`npm run eval` runs Prism's deterministic orchestration regression suite. It
uses fake executors and in-memory stores, so CI never needs model credits,
GitHub credentials, or a live backend. The checked-in machine-readable
baseline at `fixtures/evals/orchestration.baseline.json` defines thresholds for
completion, validation/review, safety, operator intervention, duration, and
estimated cost. `npm run verify` includes this suite along with package smoke
and compatibility coverage for older graphs and stores.

Maintainers can opt into a Codex/GitHub smoke test against a disposable
repository, but it is deliberately outside required public CI: it exercises
the privileged backend boundary rather than the deterministic orchestrator.

Status: `0.1.0-alpha.0` (unpublished).
