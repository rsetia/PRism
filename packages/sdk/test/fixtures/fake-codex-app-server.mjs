import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

lines.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    if (message.params.sandbox !== "read-only") {
      throw new Error(`unexpected sandbox: ${message.params.sandbox}`);
    }
    const threadId = message.params.threadId ?? "thread-1";
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    const prompt = message.params.input[0].text;
    const match = prompt.match(/- On success, write (.+) as JSON:/);
    if (!match) throw new Error("result path missing from prompt");
    await mkdir(dirname(match[1]), { recursive: true });
    await writeFile(
      match[1],
      JSON.stringify({ status: "succeeded", output: "ok" }),
    );
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: message.params.threadId,
        turnId: "turn-1",
        itemId: "item-1",
        delta: "working",
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: { id: "turn-1", status: "completed", error: null },
      },
    });
    setTimeout(() => process.exit(0), 10);
    return;
  }
  send({ id: message.id, result: {} });
});
