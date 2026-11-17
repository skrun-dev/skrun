import { watch } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { AgentConfig } from "@skrun-dev/schema";
import {
  runBodyInput,
  runDeclaredInputsRefusal,
  runInputTypeRefusal,
  validateAgent,
} from "@skrun-dev/schema";
import type { Command } from "commander";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { mockRun } from "../utils/mock-runner.js";
import { getValidatedConfig } from "../utils/validated-config.js";
import { printValidationWarnings } from "../utils/validation-output.js";

export function registerDevCommand(program: Command): void {
  program
    .command("dev")
    .description("Start local development server with POST /run")
    .option("--port <port>", "Server port", "3000")
    .action(async (opts) => {
      await runDev(opts.port);
    });
}

async function runDev(portStr: string): Promise<void> {
  const port = Number.parseInt(portStr, 10);
  const dir = process.cwd();

  // Validate agent
  let config: AgentConfig;
  const result = await validateAgent(dir);
  if (!result.valid) {
    for (const err of result.errors) {
      format.error(`${err.file ?? ""}: ${err.message}`);
    }
    exitWith(1);
  }
  config = getValidatedConfig(result);
  printValidationWarnings(result);

  // Start HTTP server
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    if (req.url !== "/run" || req.method !== "POST") {
      res.writeHead(404);
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Use POST /run" } }));
      return;
    }

    // Read body
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } }));
      return;
    }
    // The agent's input is the body's `input` field, read by the same rule
    // and refused in the same words as by the API's POST /run: never the
    // whole body. Then an input that is not an object — a string, a number,
    // a boolean — is refused as the API refuses it, its type named; then each
    // input the agent declares, its absence — no field of the input's own,
    // null, or an empty list for a file input — then its type. A file input is
    // judged for its absence only: this server reads no file.
    const reading = runBodyInput(parsed);
    if ("refusal" in reading) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: reading.refusal }));
      return;
    }
    const typeRefusal = runInputTypeRefusal(reading.input);
    if (typeRefusal) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: typeRefusal }));
      return;
    }
    const input = reading.input as Record<string, unknown>;
    const inputsRefusal = runDeclaredInputsRefusal(config.inputs, input);
    if (inputsRefusal) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: inputsRefusal }));
      return;
    }

    try {
      const runResult = mockRun(config, input);
      res.writeHead(200);
      res.end(JSON.stringify(runResult));
    } catch (err) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: {
            code: "VALIDATION_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    }
  });

  // Listen, awaited: a port in use ends the command here, inside the command,
  // where exitWith() reaches the exit code — an exit thrown from the server's
  // error event would land after the command returned, as an uncaught
  // exception. Nothing is watched before the server listens.
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      format.error(`Port ${port} is in use. Try \`skrun dev --port ${port + 1}\``);
      exitWith(1);
    }
    throw err;
  }
  format.success(`Agent validated: ${config.name}`);
  format.success(`Server running at http://localhost:${port}`);
  format.info("POST /run ready — watching for changes...");

  // Watch for file changes
  const filesToWatch = ["SKILL.md", "agent.yaml"];
  for (const file of filesToWatch) {
    try {
      watch(resolve(dir, file), async () => {
        const revalidation = await validateAgent(dir);
        if (revalidation.valid) {
          config = getValidatedConfig(revalidation);
          format.success(`Reloaded — ${file} changed`);
          printValidationWarnings(revalidation);
        } else {
          for (const err of revalidation.errors) {
            format.warn(
              `Validation error: ${err.message}. Server still running with previous config.`,
            );
          }
        }
      });
    } catch {
      // File might not exist, skip watching
    }
  }

  // Graceful shutdown: the server keeps the process alive on purpose, and a
  // signal is the way to stop it — one of the two places the CLI ends the
  // process itself.
  const shutdown = () => {
    format.info("Shutting down...");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
