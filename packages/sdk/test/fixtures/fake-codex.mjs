import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const nodeDir = process.env.AGENT_GRAPH_NODE_DIR;
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

const spec = JSON.parse(await readFile(join(nodeDir, "spec.json"), "utf8"));
const mode = spec.config?.mode ?? "success";
const resultPath = join(nodeDir, "result.json");

if (mode === "success" || mode === "result-then-stall") {
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
