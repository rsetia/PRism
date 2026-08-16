# Security

## Trust model — read this before running a graph you didn't write

Prism executes real commands. Agent-backed process boundaries have two explicit
host-selected modes; graph data cannot select or weaken them:

- **Isolated (SDK default):** a child receives only `PATH`, Prism's worker
  protocol variable, and variables explicitly allowlisted or supplied by the
  host. Codex must use a sandbox and cannot request `danger-full-access`.
  Production deployments should combine this mode with an `ExecutionBackend`
  or `WorkspaceProvisioner` whose `isolation` capability is `"isolated"`
  (for example a container or pod) to enforce filesystem and network policy.
- **Trusted local (CLI compatibility mode):** the child inherits the host
  environment and Codex contracts may bypass its sandbox. The bundled CLI
  selects this mode explicitly because its implementation/review workers need
  local Git metadata, host credentials, and GitHub network access. Use it only
  for graphs and repositories you trust as fully as a shell script.

The boundary Prism enforces is narrow and specific:

- **Graph and config files are untrusted _data_.** `parseGraph` validates them
  at a trust boundary — unknown fields, bad types, cycles, and dangling
  dependencies are rejected before anything runs. A malformed graph cannot
  crash the engine or reach an executor.
- **Configured executor names and commands are trusted _code_.** A graph that
  names the `implement` executor, or sets `validationCommands: ["rm -rf …"]`,
  is asking Prism to run that. Environment filtering does not make arbitrary
  configured commands safe.

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
- Isolated execution rejects unrestricted environment inheritance and unsafe
  Codex sandbox combinations before a child process starts.
- Values named by `secretNames`, plus literal `redactValues`, are removed from
  captured agent logs and persisted worker errors. Keep credentials host-side
  where possible; redaction limits accidental disclosure but is not a vault.

## What Prism does NOT do

- The SDK's environment policy is not itself a container, privilege drop,
  filesystem allowlist, or network firewall. Use an isolated backend/workspace
  implementation for those controls.
- Trusted-local children can read anything the current user can read and can
  reach the host network.
- Secrets deliberately sent to an agent remain visible to that agent and any
  command it invokes. Prefer scoped host-side operations over raw credentials.

Cancellation terminates the supervised child, but external operations already
performed by that child may not be reversible.

## Evaluation and release boundary

`npm run eval` uses fake executors and in-memory stores only; it never makes
paid model calls or uses live GitHub credentials. A maintainer may separately
opt into a Codex/GitHub smoke against a disposable repository, but that check
is not public CI. This keeps release proof repeatable while making the
privileged executor boundary explicit.

## Supported versions

Prism is pre-1.0 (`0.1.0-alpha.0`). Only the latest commit on `main` is
supported.

## Reporting a vulnerability

Email **ravpreetsetia@gmail.com** with details and, if possible, a minimal
reproduction. Please do not open a public issue for a security report until it
has been addressed.
