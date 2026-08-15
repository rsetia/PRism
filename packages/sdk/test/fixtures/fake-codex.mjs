import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const nodeDir = process.env.PRISM_NODE_DIR;
if (nodeDir === undefined) {
  process.exit(20);
}

let prompt = "";
for await (const chunk of process.stdin) {
  prompt += chunk;
}
await writeFile(join(nodeDir, "captured-prompt.txt"), prompt, "utf8");
await writeFile(
  join(nodeDir, "captured-args.json"),
  JSON.stringify(process.argv.slice(2)),
  "utf8",
);
await writeFile(
  join(nodeDir, "captured-env.json"),
  JSON.stringify(process.env),
);

const spec = JSON.parse(await readFile(join(nodeDir, "spec.json"), "utf8"));
const mode = spec.config?.mode ?? "success";
const resultPath = join(nodeDir, "result.json");
const phasePath = join(nodeDir, "phase.json");

process.stdout.write("fake codex stdout\n");
process.stderr.write("fake codex stderr\n");
if (mode === "secret-output") {
  const exposed = `secret=${process.env.TEST_AGENT_SECRET}\n`;
  const split = Math.floor(exposed.length / 2);
  process.stdout.write(exposed.slice(0, split));
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.stdout.write(exposed.slice(split));
  await writeFile(
    resultPath,
    JSON.stringify({
      status: "failed",
      error: `failed with ${process.env.TEST_AGENT_SECRET}`,
      failureClass: "semantic_failed",
    }),
  );
} else if (
  mode === "success" ||
  mode === "result-then-stall" ||
  mode === "phases"
) {
  if (mode === "phases") {
    await writeFile(phasePath, JSON.stringify({ phase: "implementation" }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(phasePath, JSON.stringify({ phase: "validation" }));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await writeFile(
    resultPath,
    JSON.stringify({ status: "succeeded", output: spec.input }),
  );
  if (mode === "result-then-stall") {
    setInterval(() => undefined, 1_000);
  }
} else if (mode === "reported-failure") {
  await writeFile(
    resultPath,
    JSON.stringify({
      status: "failed",
      error: "agent failed",
      failureClass: "semantic_failed",
    }),
  );
} else if (mode === "malformed-result") {
  await writeFile(resultPath, '{"status":"succeeded"}');
} else if (mode === "exit-no-result") {
  const outputIndex = process.argv.indexOf("-o");
  const lastMessagePath = process.argv[outputIndex + 1];
  if (outputIndex >= 0 && lastMessagePath !== undefined) {
    await writeFile(lastMessagePath, "fake codex details", "utf8");
  }
  process.exitCode = 7;
} else if (mode === "stall") {
  setInterval(() => undefined, 1_000);
} else {
  process.exitCode = 21;
}
