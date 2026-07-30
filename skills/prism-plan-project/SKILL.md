---
name: prism-plan-project
description: Turn a project discussion and repository into a grounded product/engineering plan, a Beads backlog, and an executable Prism DAG. Use when an agent is asked to propose project improvements, convert a roadmap or conversation into Beads, determine which work can run in parallel, design the correct dependency graph, or generate a Prism workflow with Codex implementation and Claude, Greptile, or no pull-request review.
---

# Prism Plan Project

Convert ambiguous product intent into two artifacts:

- Beads that preserve the product and engineering reasoning.
- A Prism graph that deterministically executes those Beads.

Keep semantic planning in the agent workflow. Use `prism beads-dag` only after
the work items and dependencies are correct; it is a compiler, not a product
planner.

## 1. Discover the project

Inspect before proposing work:

- Read repository instructions and the primary product and architecture docs.
- Inspect the relevant source, tests, build commands, git state, and current
  roadmap or issue tracker.
- Locate the code repository and its Beads workspace independently. They may be
  separate directories.
- Reuse existing Beads when they already represent the requested work.
- Preserve unrelated local changes.

### Resolve the Beads workspace

Use this precedence:

1. An explicit Beads path supplied by the user or repository instructions.
2. `$PRISM_HOME/beads/<project-slug>` when `PRISM_HOME` is set.
3. An existing Beads workspace in the code repository.
4. Explain how to set `PRISM_HOME`, then ask where to store Beads when
   none of the above resolves a location.

Read `PRISM_HOME` from the agent process environment; do not require the
user to repeat a value already exported in their shell.

When `PRISM_HOME` is unset, inform the user before creating Beads:

```text
PRISM_HOME is not set. Prism uses it as one absolute root for project-scoped
Beads workspaces, durable run stores, agent worktrees, and worker logs. Set it
in your shell, for example:

export PRISM_HOME="/absolute/path/to/prism-home"

Add that export to your shell profile and restart the agent, or provide an
explicit Beads path for this project.
```

Do not silently select a permanent root or edit the user's shell profile.
Continue without the variable only when an explicit path or existing project
workspace resolves the location.

Derive `project-slug` from the git repository root directory name. Normalize it
to a non-empty lowercase slug containing only letters, digits, dots,
underscores, and hyphens. Do not derive it from the current subdirectory.

Treat `PRISM_HOME` as an umbrella directory, not as a Beads database or code
repository. Require it to resolve to an absolute, non-root path. Never
recursively modify or remove the root. Prism's convention is:

```text
$PRISM_HOME/
├── beads/<project-slug>/
├── store/<project-slug>/runs.db
├── worktrees/<project-slug>/
└── logs/<project-slug>/
```

For example:

```bash
export PRISM_HOME="$HOME/2026"
```

For a repository named `conversation-coach`, resolve:

```text
$PRISM_HOME/beads/conversation-coach
```

When the resolved project workspace already contains Beads, reuse it. When it
does not exist and the user asked to create a plan or Beads, create only that
project directory and initialize it non-interactively:

```bash
mkdir -p "<resolved-beads-repo>"
git -C "<resolved-beads-repo>" init
(cd "<resolved-beads-repo>" && bd init --non-interactive --skip-agents)
```

Run `bd init` inside the resolved Beads repository. Do not force or reinitialize
an existing database. If the target exists with unrelated content or its
project identity is ambiguous, stop and ask.

Do not repurpose Beads' native `BEADS_DIR` variable for this convention;
`PRISM_HOME` supplies Prism's operator-owned directory tree, while
`--beads-repo` remains an explicit override for the exact Beads workspace.

## 2. Establish the outcome

Restate the desired user outcome and the observed implementation constraints.
Resolve only questions that materially change scope, architecture, privacy,
review policy, or release criteria. Infer ordinary details from the repository
instead of turning planning into an interview.

When improvements have not been supplied, propose a focused set that combines:

- User value and workflow.
- Reliability and failure behavior.
- Data contracts and persistence.
- Privacy, security, and retention.
- Evaluation, observability, and release validation.

Ground every proposal in evidence from the discussion or repository. Avoid
generic feature lists.

## 3. Design the work items

Create one coordinating epic and atomic child Beads unless the project already
has an equivalent structure. Give every implementation Bead:

- A user- or system-visible title.
- A description of the outcome, not merely the files to edit.
- A design section recording important boundaries and tradeoffs.
- Testable acceptance criteria, including relevant failure states.
- Product and engineering labels appropriate to the work.
- Priority or estimate when the repository convention uses them.

Keep tasks independently mergeable. Split work when separate owners could
implement it without coordinating edits continually. Combine work when the
pieces cannot produce a coherent or testable result separately.

Use `bd` for Beads mutations. Never hand-edit its database or exported JSONL.
Update matching Beads rather than creating duplicates.

## 4. Construct the dependency DAG

Add a hard dependency only when the dependent task requires a concrete output
from the prerequisite. Do not use dependencies merely to express topical
similarity or preferred scheduling.

Prefer this general shape when it fits the project:

1. Product contracts, technical contracts, and evaluation baselines.
2. Shared domain models, schemas, and persistence.
3. Independent feature, UI, service, reliability, and infrastructure branches.
4. Cross-feature aggregation or longitudinal behavior.
5. End-to-end integration, migration, and release validation.

Apply these rules:

- Let independent roots and branches fan out.
- Make downstream implementation depend on the upstream merge result, not only
  on the upstream implementation attempt.
- Serialize merge/update chains by default so concurrent successful branches do
  not race each other into the target branch.
- Ignore parent-child, related-to, and other soft Beads relationships as
  execution dependencies.
- Finish with integration only after every artifact it validates is available.
- Reject cycles, missing hard dependencies, duplicate work, and orphaned
  release tasks.

Describe the DAG as execution waves so the user can verify the parallelism
before anything runs.

## 5. Select implementation and review policy

Default to:

- `implement` nodes backed by Codex.
- Claude pull-request review.
- The exact Claude trigger comment `@claude review`.
- Approval, no unresolved actionable findings, and green required checks.
- `merge_resolve` after the implementation review gate.
- `beads_update` after a successful merge.

The reviewer is part of each implementation node's review loop, not a separate
parallel DAG node. The implementation node must push its branch, open or update
the pull request, post the trigger comment, wait for current-head Claude
feedback, address actionable feedback, validate again, and repeat until
approved or the iteration limit is reached.

Use Greptile or no reviewer only when the user or project explicitly requests
it. Never claim a reviewer is available without checking the repository's
GitHub integration or documented convention.

## 6. Choose validation

Discover validation commands from repository instructions, package scripts,
CI, and existing developer workflows. Prefer the smallest commands that
exercise each task's changed surface, plus broader commands at merge or final
integration boundaries.

Do not invent commands. If required validation needs unavailable credentials,
hardware, services, or signing, record that constraint in the Bead and graph
handoff.

## 7. Generate the Prism graph

Generate the graph from the selected Beads:

```bash
(cd <code-repo> && prism beads-dag \
  --out <project>.prism.json \
  --id <bead-id> \
  --reviewer claude \
  --review-trigger-comment "@claude review" \
  --validation-command "<implementation validation>" \
  --merge-validation-command "<merge validation>")
```

Repeat `--id`, `--label`, and validation flags as needed. Prefer explicit IDs
for a scoped project DAG so unrelated open Beads and the coordinating epic are
not accidentally implemented. When `PRISM_HOME` is configured, the current
Git repository and `$PRISM_HOME/beads/<project-slug>` are implicit. Pass
`--repo` or `--beads-repo` only to override those locations.

Use `--no-beads-update`, `--no-merge-nodes`, or
`--no-serialize-merges` only when the requested workflow requires that
behavior.

## 8. Validate without executing

Run:

```bash
prism validate <project>.prism.json
prism graph <project>.prism.json
```

Also inspect the generated graph and verify:

- Every selected implementation Bead appears exactly once.
- No unrelated Bead or coordinating epic appears as implementation work.
- Every hard dependency points in the intended direction.
- Ready implementation branches remain parallel.
- Merge/update nodes form the intended serialized lane.
- Every `implement` node uses the selected reviewer.
- Claude nodes contain `triggerComment: "@claude review"` when Claude review is
  selected.
- Validation commands and Beads paths are correct.
- Every executor name is registered by the installed Prism version.
- The final node covers all terminal work.

Do not start `prism run` unless the user explicitly asks to execute the graph.

## 9. Hand off the plan

Report:

- The product and engineering improvements selected.
- Bead IDs and the coordinating epic.
- The graph artifact path.
- Execution waves and important dependency decisions.
- Implementor and reviewer policy.
- Validation performed and any remaining constraints.
- A final `Next steps` section with exact, copyable commands.

End every successful DAG handoff with this user-facing structure, substituting
the real repository and graph paths:

```text
Next steps

Run the DAG from the project repository:
  prism run <absolute-graph-path>

While it runs, open another terminal in the same repository:
  prism watch
  prism logs
```

Do not omit this section merely because the commands appeared earlier in the
conversation. Make clear that `prism run` executes the work, `prism watch`
monitors node state until completion, and `prism logs` shows durable worker
output. Do not start any of them unless the user explicitly asks to execute
the graph.

Prism generates the run id. `watch` selects the newest unfinished run and
`logs` selects the newest run, so the default handoff does not require the
user to copy an id. The CLI defaults to four-way concurrency; specify a
different value only when the graph or resource limits justify it, and do not
imply that concurrency overrides dependency edges. With `PRISM_HOME`
configured, project paths are inferred. Use explicit path flags only when
overriding that convention.
