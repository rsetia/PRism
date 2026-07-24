import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Integration tests spawn the BUILT executable — in-process calls prove
 * nothing about bin wiring, argument handling, stream separation, or
 * exit codes. Requires `npm run build` first (verify runs build before
 * test).
 */
const CLI_PATH = fileURLToPath(new URL("../dist/main.js", import.meta.url));
if (!existsSync(CLI_PATH)) {
  throw new Error("CLI is not built — run `npm run build` first");
}

const execFileAsync = promisify(execFile);

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(...args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, ...args],
      { timeout: 10_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failed.code === "number" ? failed.code : -1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

describe("agent-graph CLI", () => {
  test("no command prints usage to stderr, exit 2", async () => {
    const result = await cli();
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });

  test("unknown command exits 2", async () => {
    const result = await cli("frobnicate");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });

  test("unrecognized flag exits 2", async () => {
    const result = await cli("run", fixture("valid.json"), "--bogus");
    expect(result.code).toBe(2);
  });

  test("validate: valid file exits 0 with empty stdout", async () => {
    const result = await cli("validate", fixture("valid.json"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("validate: compile error goes to stderr with its code, exit 2", async () => {
    const result = await cli("validate", fixture("invalid.json"));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CYCLE");
  });

  test("validate: missing file exits 2 with a diagnostic", async () => {
    const result = await cli("validate", fixture("does-not-exist.json"));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });

  test("validate: malformed JSON exits 2", async () => {
    const result = await cli("validate", fixture("malformed.json"));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });

  test("graph: stable text plan on stdout", async () => {
    const result = await cli("graph", fixture("valid.json"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      ["first (constant)", "second (passthrough) <- first", "final: second"]
        .map((line) => `${line}\n`)
        .join(""),
    );
  });

  test("graph --json: versioned, parseable, pure stdout", async () => {
    const result = await cli("graph", fixture("valid.json"), "--json");
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout) as {
      version: number;
      order: string[];
      finalNode: string;
      nodes: Record<
        string,
        { executor: string; kind: string; dependsOn: string[] }
      >;
    };
    expect(plan.version).toBe(1);
    expect(plan.order).toEqual(["first", "second"]);
    expect(plan.finalNode).toBe("second");
    expect(plan.nodes["second"]?.kind).toBe("task");
    expect(plan.nodes["second"]?.dependsOn).toEqual(["first"]);
  });

  test("run: success prints the output value to stdout, exit 0", async () => {
    const result = await cli("run", fixture("valid.json"));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('"hello"');
  });

  test("run --json: versioned success envelope", async () => {
    const result = await cli("run", fixture("valid.json"), "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      status: "succeeded",
      output: "hello",
    });
  });

  test("run: graph failure is exit 1 with empty stdout", async () => {
    const result = await cli("run", fixture("failing.json"));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("doomed");
  });

  test("run --json: versioned failure envelope, exit 1", async () => {
    const result = await cli("run", fixture("failing.json"), "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      status: "failed",
      failures: [{ nodeId: "doomed", cause: { reason: "boom" } }],
    });
  });

  test("run: invalid graph never starts a run, exit 2", async () => {
    const result = await cli("run", fixture("invalid.json"));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });

  test("run: a YAML graph runs like its JSON equivalent", async () => {
    const result = await cli("run", fixture("valid.yaml"), "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      status: "succeeded",
      output: "hello",
    });
  });

  test("graph: a YAML graph compiles to the same plan", async () => {
    const result = await cli("graph", fixture("valid.yaml"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      ["first (constant)", "second (passthrough) <- first", "final: second"]
        .map((line) => `${line}\n`)
        .join(""),
    );
  });
});

describe("agent-graph CLI: persisted runs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-graph-cli-store-"));
  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  let counter = 0;
  function db(): string {
    counter += 1;
    return join(tempDir, `runs-${String(counter)}.db`);
  }

  function runIdFrom(stderr: string): string {
    const match = /^run (.+)$/mu.exec(stderr);
    if (match?.[1] === undefined) {
      throw new Error(`run id missing from stderr: ${stderr}`);
    }
    return match[1];
  }

  test("run --store persists, then inspect reports node states", async () => {
    const store = db();
    const ran = await cli(
      "run",
      fixture("valid.json"),
      "--store",
      store,
      "--run-id",
      "r1",
    );
    expect(ran.code).toBe(0);
    expect(runIdFrom(ran.stderr)).toBe("r1");

    const inspected = await cli("inspect", "r1", "--store", store);
    expect(inspected.code).toBe(0);
    expect(inspected.stdout).toContain("first: succeeded");
    expect(inspected.stdout).toContain("second: succeeded");
    expect(inspected.stdout).toContain("finished: true");
  });

  test("inspect --json is a versioned envelope", async () => {
    const store = db();
    await cli("run", fixture("valid.json"), "--store", store, "--run-id", "r2");
    const inspected = await cli("inspect", "r2", "--store", store, "--json");
    expect(inspected.code).toBe(0);
    const parsed = JSON.parse(inspected.stdout) as {
      version: number;
      runId: string;
      finished: boolean;
      nodes: { nodeId: string; state: string }[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.runId).toBe("r2");
    expect(parsed.finished).toBe(true);
    expect(parsed.nodes.map((n) => n.state)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });

  test("events lists the persisted event log in order", async () => {
    const store = db();
    await cli("run", fixture("valid.json"), "--store", store, "--run-id", "r3");
    const events = await cli("events", "r3", "--store", store);
    expect(events.code).toBe(0);
    const lines = events.stdout.trim().split("\n");
    expect(lines[0]).toBe("0 node_ready first");
    expect(events.stdout).toContain("node_succeeded second");
  });

  test("events --json preserves full ordered event payloads", async () => {
    const store = db();
    await cli("run", fixture("valid.json"), "--store", store, "--run-id", "r4");
    const result = await cli("events", "r4", "--store", store, "--json");
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      version: number;
      runId: string;
      events: {
        seq: number;
        kind: string;
        nodeId: string;
        output?: unknown;
      }[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.runId).toBe("r4");
    expect(parsed.events.map((event) => event.seq)).toEqual(
      parsed.events.map((_event, index) => index),
    );
    expect(parsed.events.at(-1)).toMatchObject({
      kind: "node_succeeded",
      nodeId: "second",
      output: "hello",
    });
  });

  test("inspect of an unknown run exits 2", async () => {
    const inspected = await cli("inspect", "ghost", "--store", db());
    expect(inspected.code).toBe(2);
    expect(inspected.stdout).toBe("");
  });

  test("inspect without --store is a usage error", async () => {
    const inspected = await cli("inspect", "r1");
    expect(inspected.code).toBe(2);
    expect(inspected.stderr).toContain("Usage:");
  });

  test("events of an unknown run exits 2", async () => {
    const events = await cli("events", "ghost", "--store", db());
    expect(events.code).toBe(2);
    expect(events.stdout).toBe("");
    expect(events.stderr).toContain("unknown run");
  });

  test("persistent runs without explicit ids receive unique durable ids", async () => {
    const store = db();
    const first = await cli("run", fixture("valid.json"), "--store", store);
    const second = await cli("run", fixture("valid.json"), "--store", store);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const firstId = runIdFrom(first.stderr);
    const secondId = runIdFrom(second.stderr);
    expect(firstId).not.toBe(secondId);
    expect(firstId).toMatch(/^run-/u);
    expect((await cli("inspect", firstId, "--store", store)).code).toBe(0);
    expect((await cli("inspect", secondId, "--store", store)).code).toBe(0);
  });

  test("a duplicate explicit run id is a usage error", async () => {
    const store = db();
    await cli(
      "run",
      fixture("valid.json"),
      "--store",
      store,
      "--run-id",
      "duplicate",
    );
    const duplicate = await cli(
      "run",
      fixture("valid.json"),
      "--store",
      store,
      "--run-id",
      "duplicate",
    );
    expect(duplicate.code).toBe(2);
    expect(duplicate.stdout).toBe("");
    expect(duplicate.stderr).toContain("run already exists");
  });

  test("a persisted failing run reports failed and blocked", async () => {
    const store = db();
    await cli(
      "run",
      fixture("failing.json"),
      "--store",
      store,
      "--run-id",
      "rf",
    );
    const inspected = await cli("inspect", "rf", "--store", store);
    expect(inspected.code).toBe(0);
    expect(inspected.stdout).toContain("doomed: failed");
    expect(inspected.stdout).toContain('failure doomed: {"reason":"boom"}');
  });
});
