import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteStore } from "@rsetia/prism/node";
import { inspectRun } from "@rsetia/prism";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * `prism poll` never exits on its own, so these tests spawn the built CLI,
 * watch its stderr and durable store, and stop it the way an operator
 * would. A local HTTP server stands in for Linear via source.apiUrl.
 */
const CLI_PATH = fileURLToPath(new URL("../dist/main.js", import.meta.url));

interface FakeLinear {
  readonly url: string;
  issues: unknown[];
  readonly queries: string[];
  close(): Promise<void>;
}

async function startFakeLinear(): Promise<FakeLinear> {
  const state: { issues: unknown[]; queries: string[] } = {
    issues: [],
    queries: [],
  };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const { query } = JSON.parse(body) as { query: string };
      const name = /query (\w+)/u.exec(query)?.[1] ?? "unknown";
      state.queries.push(name);
      response.setHeader("content-type", "application/json");
      if (request.headers["authorization"] !== "test-key") {
        response.statusCode = 401;
        response.end(
          JSON.stringify({ errors: [{ message: "Authentication required" }] }),
        );
        return;
      }
      if (name === "PrismPollViewer") {
        response.end(
          JSON.stringify({ data: { viewer: { id: "me", name: "Test User" } } }),
        );
      } else if (name === "PrismPollCandidates") {
        response.end(
          JSON.stringify({
            data: {
              viewer: { id: "me" },
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: state.issues,
              },
            },
          }),
        );
      } else {
        response.end(
          JSON.stringify({
            data: {
              issue: {
                id: "uuid-1",
                identifier: "ENG-7",
                title: "Queued from Linear",
                description: "Acceptance: it works",
                url: "https://linear.app/x/issue/ENG-7",
                branchName: "test/eng-7-queued",
                state: { name: "Todo", type: "unstarted" },
                labels: { nodes: [{ name: "agent-implemented" }] },
                comments: { nodes: [] },
                attachments: { nodes: [] },
                relations: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/graphql`,
    get issues() {
      return state.issues;
    },
    set issues(value: unknown[]) {
      state.issues = value;
    },
    queries: state.queries,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface Running {
  readonly child: ChildProcess;
  stderr: string;
  readonly exited: Promise<number | null>;
}

function startPoll(
  cwd: string,
  prismHome: string,
  args: readonly string[],
  env: Record<string, string | undefined> = { LINEAR_API_KEY: "test-key" },
): Running {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PRISM_HOME: prismHome,
    // A killed poller's leases gate the restart; keep that window short.
    PRISM_LEASE_DURATION_MS: "1000",
  };
  delete childEnv["LINEAR_API_KEY"];
  delete childEnv["LINEAR_TOKEN"];
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, [CLI_PATH, "poll", ...args], {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running: Running = {
    child,
    stderr: "",
    exited: new Promise((resolve) => {
      child.once("exit", (code) => resolve(code));
    }),
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    running.stderr += chunk.toString("utf8");
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    running.stderr += `[stdout] ${chunk.toString("utf8")}`;
  });
  return running;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  describeState: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out; ${describeState()}`);
}

async function stop(running: Running): Promise<void> {
  running.child.kill("SIGTERM");
  await running.exited;
}

describe("prism poll", { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "prism-poll-cli-"));
  const prismHome = join(root, "home");
  const project = join(root, "project");
  let linear: FakeLinear;

  beforeAll(async () => {
    mkdirSync(project);
    linear = await startFakeLinear();
  });
  afterAll(async () => {
    await linear.close();
    rmSync(root, { recursive: true, force: true });
  });

  function writeConfig(name: string, extra: Record<string, unknown> = {}) {
    const file = join(root, `${name}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        name,
        intervalSeconds: 30,
        source: {
          kind: "linear",
          label: "agent-implemented",
          apiUrl: linear.url,
        },
        ...extra,
      }),
    );
    return file;
  }

  function storePath(): string {
    return join(prismHome, "store", "project", "runs.db");
  }

  test("rejects an invalid config before touching the network", async () => {
    const file = join(root, "bad.json");
    writeFileSync(
      file,
      JSON.stringify({ name: "bad", source: { kind: "linear" }, typo: 1 }),
    );
    const running = startPoll(project, prismHome, [file]);
    expect(await running.exited).toBe(2);
    expect(running.stderr).toContain("invalid poll config");
    expect(running.stderr).toContain('unknown key "typo"');
  });

  test("rejects an unknown source", async () => {
    const file = join(root, "jira.json");
    writeFileSync(
      file,
      JSON.stringify({ name: "jira", source: { kind: "jira" } }),
    );
    const running = startPoll(project, prismHome, [file]);
    expect(await running.exited).toBe(2);
    expect(running.stderr).toContain(
      'unknown source "jira" (available: linear)',
    );
  });

  test("explains a missing Linear token without starting a run", async () => {
    const running = startPoll(
      project,
      prismHome,
      [writeConfig("no-token")],
      {},
    );
    expect(await running.exited).toBe(2);
    expect(running.stderr).toContain(
      "cannot reach linear: Linear token not found: export LINEAR_API_KEY (or LINEAR_TOKEN)",
    );
  });

  test("starts one durable poll run, resumes it, and warns on config drift", async () => {
    linear.issues = [];
    const config = writeConfig("tickets");
    const first = startPoll(project, prismHome, [config]);
    await waitFor(
      () => first.stderr.includes("0 matching, 0 newly queued"),
      () => first.stderr,
    );
    expect(first.stderr).toContain("Linear authenticated as Test User");
    expect(first.stderr).toMatch(/^run poll-tickets$/mu);
    expect(first.stderr).toContain(
      "polling linear every 30s with up to 3 implementers; follow with: prism watch poll-tickets",
    );
    await stop(first);

    const resumed = startPoll(project, prismHome, [config]);
    await waitFor(
      () => resumed.stderr.includes("0 matching, 0 newly queued"),
      () => resumed.stderr,
    );
    // Whether the restart had to wait out the killed poller's leases depends
    // on how long this child took to start, so only the resume is asserted.
    expect(resumed.stderr).toMatch(/^resume poll-tickets$/mu);
    expect(resumed.stderr).not.toContain("warning:");
    await stop(resumed);

    const drifted = startPoll(project, prismHome, [
      writeConfig("tickets", { maxParallel: 5 }),
    ]);
    await waitFor(
      () => drifted.stderr.includes("0 matching, 0 newly queued"),
      () => drifted.stderr,
    );
    expect(drifted.stderr).toContain(
      'differs from the config stored in poll run "poll-tickets"; resuming with the stored config',
    );
    expect(drifted.stderr).toContain("with up to 3 implementers");
    await stop(drifted);
  });

  test("refuses to share a poll run with a poller that is still running", async () => {
    linear.issues = [];
    const config = writeConfig("shared");
    const live = startPoll(project, prismHome, [config]);
    await waitFor(
      () => live.stderr.includes("0 matching, 0 newly queued"),
      () => live.stderr,
    );
    const second = startPoll(project, prismHome, [config]);
    expect(await second.exited).toBe(2);
    expect(second.stderr).toContain(
      'poll run "poll-shared" is owned by a running process',
    );
    await stop(live);
  });

  test("queues a matching issue once, with its snapshot, across restarts", async () => {
    linear.issues = [
      {
        id: "uuid-1",
        identifier: "ENG-7",
        title: "Queued from Linear",
        url: "https://linear.app/x/issue/ENG-7",
        creator: { id: "me" },
        labels: { nodes: [{ id: "l1", name: "agent-implemented" }] },
        history: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
      {
        id: "uuid-2",
        identifier: "ENG-8",
        title: "Labeled by someone else",
        url: "https://linear.app/x/issue/ENG-8",
        creator: { id: "teammate" },
        labels: { nodes: [{ id: "l1", name: "agent-implemented" }] },
        history: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const config = writeConfig("queue");
    const first = startPoll(project, prismHome, [config]);
    await waitFor(
      () => first.stderr.includes("1 matching, 1 newly queued"),
      () => first.stderr,
    );
    expect(first.stderr).toContain("queued ENG-7: Queued from Linear");
    expect(first.stderr).toContain(
      'skipping ENG-8: label "agent-implemented" was not applied by you',
    );
    await stop(first);

    const resumed = startPoll(project, prismHome, [config]);
    await waitFor(
      () => resumed.stderr.includes("1 matching"),
      () => resumed.stderr,
    );
    await stop(resumed);

    const store = createSqliteStore({ path: storePath() });
    try {
      const revisions = (await store.listGraphRevisions?.("poll-queue")) ?? [];
      // The restart re-submitted ENG-7; its proposal id kept it single.
      expect(revisions.map((revision) => revision.proposal.id)).toEqual([
        "poll:linear:ENG-7",
      ]);
      const run = await store.getRun("poll-queue");
      expect(run?.graph.nodes["context-linear-eng-7"]?.config).toMatchObject({
        value: {
          provider: "linear",
          id: "ENG-7",
          description: "Acceptance: it works",
          branchName: "test/eng-7-queued",
        },
      });
      expect(run?.graph.nodes["implement-linear-eng-7"]?.config).toMatchObject({
        workItem: { provider: "linear", id: "ENG-7" },
        branchName: "test/eng-7-queued",
        review: { by: "greptile", minConfidenceScore: 5 },
      });
      const inspection = await inspectRun(store, "poll-queue");
      expect(
        inspection.nodes.find((node) => node.nodeId === "context-linear-eng-7")
          ?.state,
      ).toBe("succeeded");
    } finally {
      await store.close?.();
    }
  });
});
