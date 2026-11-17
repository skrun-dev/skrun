// MCP server fixture written by hand, without the SDK, so that nothing on its
// side bounds what it writes: one JSON-RPC message per line on stdout.
//
// Tools:
// - `big` answers `mib` MiB of text.
// - `unasked` answers "ok", then sends a notification of `mib` MiB that no
//   request asked for.
// - `noisy` writes a line that is not JSON, then answers "ok": the client
//   reports an error of its transport, and the connection stays open.
//
// Every tools/call appends this process's pid to the file named by argv[2], so
// a test counts how many times a tool ran, and on how many server processes.
//
// Every start appends this process's pid to the file named by argv[3], when one
// is given. With argv[4], a start that finds that many pids already written
// there exits at once, before it answers anything: the server refuses to start
// again, and a test reads how many starts were attempted.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [, , counter, starts, maxStarts] = process.argv;
if (starts) {
  const earlier = readFileSync(starts, "utf8").split("\n").filter(Boolean).length;
  appendFileSync(starts, `${process.pid}\n`);
  if (maxStarts !== undefined && earlier >= Number(maxStarts)) process.exit(1);
}
const MIB = 1024 * 1024;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "big-answer", version: "0.0.0" },
      },
    });
  } else if (message.method === "tools/list") {
    const inputSchema = { type: "object", properties: { mib: { type: "number" } } };
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "big", description: "Answers mib MiB of text", inputSchema },
          { name: "unasked", description: "Answers, then sends mib MiB unasked", inputSchema },
          {
            name: "noisy",
            description: "Writes a line that is not JSON, then answers",
            inputSchema,
          },
        ],
      },
    });
  } else if (message.method === "tools/call") {
    appendFileSync(counter, `${process.pid}\n`);
    const { name, arguments: args } = message.params;
    const text = "x".repeat(Math.round((args.mib ?? 0) * MIB));
    if (name === "big") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
    } else if (name === "noisy") {
      process.stdout.write("not a JSON-RPC message\n");
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: "info", data: text },
        });
      }, 50);
    }
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
