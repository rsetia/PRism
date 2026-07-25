# Security

## Trust model — read this before running a graph you didn't write

Prism executes real commands on your machine. Its Node-only executors spawn
subprocesses — `codex`, `gh`, `bd`, and any `validationCommands` you configure
— **as the current user, with no sandbox and no privilege drop.** A coding
agent (`createCodexExecutor`) is given git-mutation and GitHub permissions and
runs `codex exec` inside a worktree of your repository.

The boundary Prism enforces is narrow and specific:

- **Graph and config files are untrusted _data_.** `parseGraph` validates them
  at a trust boundary — unknown fields, bad types, cycles, and dangling
  dependencies are rejected before anything runs. A malformed graph cannot
  crash the engine or reach an executor.
- **Configured executor names and commands are trusted _code_.** A graph that
  names the `implement` executor, or sets `validationCommands: ["rm -rf …"]`,
  is asking Prism to run that. Prism does **not** sandbox, allow-list, or
  otherwise contain what a configured executor does.

**Consequence: do not run a graph, or point `buildBeadsGraph` at a backlog,
from a source you do not fully trust.** Treat a `.json`/`.yaml` graph the way
you'd treat a shell script someone handed you.

## What Prism does defend

- Untrusted graph/config input is parsed and validated before use.
- Worker output (`result.json`) crosses a trust boundary from the subprocess
  and is validated, not `eval`'d.
- The local artifact store confines `get(uri)` to its base directory and
  refuses paths that escape it (including via symlinks).
- Git arguments and external commands are passed via `execFile` (no shell), so
  a branch or path with a space cannot become command injection.

## What Prism does NOT do

- **No sandboxing** of executors or the subprocesses they spawn.
- **No secret redaction** — a worker inherits the parent environment, so API
  tokens and credentials in `process.env` are visible to it. Do not put
  secrets in graph `config`; pass them via the environment, and be aware the
  worker sees them.
- **No network or filesystem policy** — a codex/subprocess node can read and
  write anywhere the user can, and reach the network.

The absence of sandboxing is by design at this stage (single-machine,
single-user, trusted-repo operation), and is called out here rather than
implied.

## Supported versions

Prism is pre-1.0 (`0.1.0-alpha.0`). Only the latest commit on `main` is
supported.

## Reporting a vulnerability

Email **ravpreetsetia@gmail.com** with details and, if possible, a minimal
reproduction. Please do not open a public issue for a security report until it
has been addressed.
