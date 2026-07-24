import { describe, expect, test } from "vitest";
import { createExecFileRunner } from "../src/node/index.js";

describe("createExecFileRunner", () => {
  test("captures stdout and stderr from a successful command", async () => {
    const result = await createExecFileRunner().run(process.execPath, [
      "-e",
      'process.stdout.write("out"); process.stderr.write("err")',
    ]);
    expect(result).toEqual({ exitCode: 0, stdout: "out", stderr: "err" });
  });

  test("resolves a non-zero process exit as command data", async () => {
    const result = await createExecFileRunner().run(process.execPath, [
      "-e",
      'process.stdout.write("no"); process.stderr.write("bad"); process.exit(7)',
    ]);
    expect(result).toEqual({ exitCode: 7, stdout: "no", stderr: "bad" });
  });

  test("passes arguments literally without a shell", async () => {
    const argument = "feature branch; echo unsafe";
    const result = await createExecFileRunner().run(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      argument,
    ]);
    expect(JSON.parse(result.stdout)).toEqual([argument]);
  });

  test("rejects a missing executable as a launch failure", async () => {
    await expect(
      createExecFileRunner().run("definitely-not-an-installed-command", []),
    ).rejects.toThrow("Could not execute");
  });

  test("rejects an aborted command with an AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createExecFileRunner().run(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("rejects output larger than the bounded buffer", async () => {
    await expect(
      createExecFileRunner().run(process.execPath, [
        "-e",
        'process.stdout.write("x".repeat(1024 * 1024 + 1))',
      ]),
    ).rejects.toThrow("maxBuffer");
  });
});
