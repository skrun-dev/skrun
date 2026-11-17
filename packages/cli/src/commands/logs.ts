import type { Command } from "commander";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { connect } from "../utils/registry-client.js";

export function registerLogsCommand(program: Command): void {
  program
    .command("logs <agent>")
    .description("Show recent execution logs for a deployed agent")
    .option("-n, --lines <n>", "Number of recent runs to show", "10")
    .action(async (agentRef: string, opts) => {
      // The server the logs come from, and its session
      const client = connect();

      const parts = agentRef.split("/");
      if (parts.length !== 2) {
        format.error('Invalid agent name. Use format: namespace/name (e.g., "acme/seo-audit")');
        exitWith(1);
      }
      const [namespace, name] = parts;

      let logs: Array<Record<string, unknown>>;
      try {
        logs = await client.logs(namespace, name, opts.lines);
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          format.error(`Agent ${namespace}/${name} not found or no logs available.`);
        } else {
          // A refusal names its status; a server that cannot be reached is named, with the cause.
          format.error(err instanceof Error ? err.message : String(err));
        }
        exitWith(1);
      }

      if (logs.length === 0) {
        format.info(`No execution logs for ${namespace}/${name}.`);
        return;
      }

      console.log(`Recent runs for ${namespace}/${name}:\n`);
      for (const log of logs) {
        const status = log.status === "completed" ? "✓" : "✗";
        const statusColor = log.status === "completed" ? "\x1b[32m" : "\x1b[31m";
        console.log(
          `  ${statusColor}${status}\x1b[0m ${log.run_id} | ${log.duration_ms}ms | $${(log.cost as number)?.toFixed(4) ?? "?"} | ${log.timestamp}`,
        );
      }
      console.log("");
    });
}
