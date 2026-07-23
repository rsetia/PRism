import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

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
