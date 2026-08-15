// Test worker following the §14 file protocol. Reads its spec, optionally
// heartbeats, and writes a result. Behavior is driven by spec.config.mode:
//   "echo" (default) — write result: succeeded, output = spec.input
//   "fail"           — write result: failed, error from config.error
//   "stall"          — write one heartbeat, then run forever (no result)
//   "beat"           — heartbeat every config.beatMs, succeed after config.beats
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const nodeDir = process.env.PRISM_NODE_DIR;
if (nodeDir === undefined) {
  process.exit(2);
}

const spec = JSON.parse(readFileSync(join(nodeDir, "spec.json"), "utf8"));
const config = spec.config ?? {};
const mode = config.mode ?? "echo";

if (config.captureEnvironment === true) {
  writeFileSync(
    join(nodeDir, "captured-env.json"),
    JSON.stringify(process.env),
  );
}

function beat() {
  writeFileSync(
    join(nodeDir, "heartbeat.json"),
    JSON.stringify({ ts: Date.now() }),
  );
}

function writeResult(result) {
  writeFileSync(join(nodeDir, "result.json"), JSON.stringify(result));
}

beat();

if (mode === "echo") {
  writeResult({ status: "succeeded", output: spec.input });
} else if (mode === "fail") {
  writeResult({
    status: "failed",
    error: config.error ?? "worker failed",
    failureClass: config.failureClass,
  });
} else if (mode === "stall") {
  // Heartbeat once, then hang without ever writing a result.
  setInterval(() => {}, 1_000);
} else if (mode === "beat") {
  let remaining = config.beats ?? 3;
  const timer = setInterval(() => {
    beat();
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(timer);
      writeResult({ status: "succeeded", output: spec.input });
    }
  }, config.beatMs ?? 10);
} else {
  process.exit(3);
}
