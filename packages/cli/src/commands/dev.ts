import { watch } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { AgentConfig } from "@skrun-dev/schema";
import { validateAgent } from "@skrun-dev/schema";
import type { Command } from "commander";
import * as format from "../utils/format.js";
import { mockRun } from "../utils/mock-runner.js";
import { getValidatedConfig } from "../utils/validated-config.js";

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
    process.exit(1);
  }
  config = getValidatedConfig(result);

  for (const w of result.warnings) {
    format.warn(w.message);
  }

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

    let input: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body);
      input = parsed.input ?? parsed;
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { code: "INVALID_REQUEST", message: "Invalid JSON body" } }));
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

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      format.error(`Port ${port} is in use. Try \`skrun dev --port ${port + 1}\``);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, () => {
    format.success(`Agent validated: ${config.name}`);
    format.success(`Server running at http://localhost:${port}`);
    format.info("POST /run ready — watching for changes...");
  });

  // Watch for file changes
  const filesToWatch = ["SKILL.md", "agent.yaml"];
  for (const file of filesToWatch) {
    try {
      watch(resolve(dir, file), async () => {
        const revalidation = await validateAgent(dir);
        if (revalidation.valid) {
          config = getValidatedConfig(revalidation);
          format.success(`Reloaded — ${file} changed`);
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

  // Graceful shutdown
  const shutdown = () => {
    format.info("Shutting down...");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
