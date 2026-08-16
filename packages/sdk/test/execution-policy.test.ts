import { describe, expect, test } from "vitest";
import {
  buildChildEnvironment,
  createSecretRedactor,
  SAFE_AGENT_EXECUTION_POLICY,
  TRUSTED_LOCAL_AGENT_EXECUTION_POLICY,
  validateAgentExecutionPolicy,
} from "../src/node/index.js";

describe("agent execution policy", () => {
  test("safe defaults do not inherit undeclared variables", () => {
    expect(
      buildChildEnvironment(
        SAFE_AGENT_EXECUTION_POLICY,
        { PATH: "/bin", HOST_TOKEN: "secret" },
        { PRISM_NODE_DIR: "/node" },
      ),
    ).toEqual({ PATH: "/bin", PRISM_NODE_DIR: "/node" });
  });

  test("supports explicit allowlisting, values, and removal", () => {
    expect(
      buildChildEnvironment(
        {
          mode: "isolated",
          environment: {
            inherit: ["LANG", "MISSING"],
            values: { SCOPED_TOKEN: "token", LANG: undefined },
          },
        },
        { LANG: "en_US", HOST_TOKEN: "secret" },
      ),
    ).toEqual({ SCOPED_TOKEN: "token" });
  });

  test("preserves explicit trusted-local environment inheritance", () => {
    expect(
      buildChildEnvironment(TRUSTED_LOCAL_AGENT_EXECUTION_POLICY, {
        PATH: "/bin",
        HOST_TOKEN: "available-to-trusted-worker",
      }),
    ).toEqual({
      PATH: "/bin",
      HOST_TOKEN: "available-to-trusted-worker",
    });
  });

  test("rejects unrestricted inheritance outside trusted-local mode", () => {
    expect(() =>
      validateAgentExecutionPolicy({
        mode: "isolated",
        environment: { inherit: "all" },
      }),
    ).toThrow(/requires trusted-local/);
  });

  test("rejects malformed policy collections", () => {
    expect(() =>
      validateAgentExecutionPolicy({
        mode: "isolated",
        environment: { secretNames: "TOKEN" as unknown as string[] },
      }),
    ).toThrow(/secretNames must be an array/);
  });

  test("redacts named and literal secret values", () => {
    const redact = createSecretRedactor(
      {
        mode: "isolated",
        environment: {
          secretNames: ["TOKEN"],
          redactValues: ["scoped-secret"],
        },
      },
      { TOKEN: "host-secret" },
    );
    expect(redact("host-secret / scoped-secret")).toBe(
      "[REDACTED] / [REDACTED]",
    );
  });
});
