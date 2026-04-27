import type { Command } from "commander";
import { getRegistryUrl, saveToken } from "../utils/auth.js";
import * as format from "../utils/format.js";
import { askText } from "../utils/prompts.js";

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Authenticate with the Skrun registry")
    .option("--token <token>", "API token or key (non-interactive, e.g. sk_live_...)")
    .action(async (opts) => {
      if (opts.token) {
        // Direct token/API key mode — store and exit
        saveToken(opts.token);
        format.success("Logged in. Token saved to ~/.skrun/config.json");
        return;
      }

      // Check if the registry supports OAuth
      const registryUrl = getRegistryUrl();
      let oauthSupported = false;
      try {
        const res = await fetch(`${registryUrl}/auth/github`, {
          method: "GET",
          redirect: "manual",
        });
        // A 302 redirect means OAuth is configured
        oauthSupported = res.status === 302;
      } catch {
        // Network error or registry not reachable — fall back to token prompt
      }

      if (oauthSupported) {
        // Browser-based OAuth flow
        const { createServer } = await import("node:http");
        const { randomUUID } = await import("node:crypto");

        const callbackToken = randomUUID();
        let resolved = false;

        const server = createServer((req, res) => {
          const url = new URL(req.url ?? "/", "http://localhost");
          if (url.pathname === "/callback") {
            const token = url.searchParams.get("token");
            const username = url.searchParams.get("username");
            if (token) {
              saveToken(token, username ?? undefined);
              resolved = true;
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end("<html><body><h2>Logged in! You can close this tab.</h2></body></html>");
              server.close();
            } else {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end("Missing token");
            }
          } else {
            res.writeHead(404);
            res.end();
          }
        });

        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", () => resolve());
        });
        const port = (server.address() as { port: number }).port;

        const loginUrl = `${registryUrl}/auth/github?cli_callback=http://127.0.0.1:${port}/callback&state=${callbackToken}`;

        format.info("Opening browser for GitHub login...");
        format.info(`If the browser doesn't open, visit: ${loginUrl}`);

        // Try to open the browser
        const { exec } = await import("node:child_process");
        if (process.platform === "win32") {
          exec(`start "" "${loginUrl}"`);
        } else if (process.platform === "darwin") {
          exec(`open "${loginUrl}"`);
        } else {
          exec(`xdg-open "${loginUrl}"`);
        }

        // Wait for callback with timeout
        const timeout = setTimeout(() => {
          if (!resolved) {
            server.close();
            format.error("Login timed out after 2 minutes. Use --token for manual login.");
          }
        }, 120_000);

        await new Promise<void>((resolve) => {
          server.on("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        if (resolved) {
          format.success("Logged in via GitHub OAuth. Token saved to ~/.skrun/config.json");
        }
      } else {
        // Fallback: interactive token prompt
        const token = await askText("Enter your API token:", "dev-token");
        saveToken(token);
        format.success("Logged in. Token saved to ~/.skrun/config.json");
      }
    });
}
