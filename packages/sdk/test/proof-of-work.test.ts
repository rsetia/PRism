import { describe, expect, test } from "vitest";
import {
  parseProofOfWork,
  PROOF_OF_WORK_VERSION,
  tryParseProofOfWork,
} from "../src/index.js";

function evidence() {
  return {
    version: PROOF_OF_WORK_VERSION,
    summary: "Shipped durable evidence",
    commits: [{ sha: "abc123" }],
    pullRequests: [
      {
        url: "https://github.com/example/repo/pull/1",
        number: 1,
        branch: "feature/evidence",
        headSha: "abc123",
      },
    ],
    validations: [{ command: "npm test", status: "passed" }],
    reviewVerdicts: [
      { reviewer: "greptile", verdict: "approved", headSha: "abc123" },
    ],
    screenshots: [
      {
        uri: "artifact://screenshots/result",
        filename: "result.png",
        size: 42,
        contentType: "image/png",
      },
    ],
    artifacts: [],
    unresolvedRisks: [],
  };
}

describe("proof-of-work contract", () => {
  test("parses complete versioned evidence", () => {
    expect(parseProofOfWork(evidence())).toEqual(evidence());
  });

  test.each([
    ["missing field", { ...evidence(), validations: undefined }],
    ["wrong version", { ...evidence(), version: 2 }],
    ["malformed commit", { ...evidence(), commits: [{ sha: "" }] }],
    [
      "malformed artifact",
      { ...evidence(), artifacts: [{ uri: "/tmp/local", filename: "x" }] },
    ],
    [
      "malformed validation",
      { ...evidence(), validations: [{ command: "npm test", status: "ok" }] },
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => parseProofOfWork(input)).toThrow();
  });

  test("recognition leaves legacy and generic outputs readable", () => {
    expect(tryParseProofOfWork("generic output")).toBeNull();
    expect(tryParseProofOfWork({ summary: "legacy" })).toBeNull();
    expect(tryParseProofOfWork({ ...evidence(), commits: [{}] })).toBeNull();
  });
});
