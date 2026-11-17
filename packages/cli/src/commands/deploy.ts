import { readFileSync } from "node:fs";
import { type AgentConfig, validateAgent, validateAgentCapabilities } from "@skrun-dev/schema";
import type { Command } from "commander";
import { resolveTarget } from "../utils/auth.js";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { connect } from "../utils/registry-client.js";
import { getValidatedConfig } from "../utils/validated-config.js";
import { printValidationWarnings } from "../utils/validation-output.js";
import { buildBundle } from "./build.js";
import { callableAtOnce, printAfterPushNote } from "./push.js";

/** The example value of a required input, by its type. */
function exampleValue(type: "string" | "number" | "boolean" | "object" | "array"): unknown {
  switch (type) {
    case "string":
      return "hello";
    case "number":
      return 1;
    case "boolean":
      return true;
    case "object":
      return {};
    case "array":
      return [];
  }
}

/**
 * The input of the command `deploy` prints to try the agent: the input of the
 * agent's first test when it declares one — what the dashboard's "Try it"
 * shows —, else an example value for each required input. A required file
 * input has no example a command line can carry: it is left out, and its name
 * returned, to be said. Each example is defined, not assigned: an input named
 * `__proto__` gets its field like any other. Pure.
 */
export function exampleInput(config: Pick<AgentConfig, "inputs" | "tests">): {
  input: Record<string, unknown>;
  filesLeftOut: string[];
} {
  const first = config.tests[0];
  if (first) return { input: first.input, filesLeftOut: [] };
  const input: Record<string, unknown> = {};
  const filesLeftOut: string[] = [];
  for (const field of config.inputs) {
    if (!field.required) continue;
    if (field.type === "file") {
      filesLeftOut.push(field.name);
      continue;
    }
    Object.defineProperty(input, field.name, {
      value: exampleValue(field.type),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { input, filesLeftOut };
}

/**
 * The lines to try the agent: `skrun run`, from a file — what every shell can
 * write — then inline, for bash and zsh. They name no server and carry no
 * token: `skrun run` takes both from the session, by the same resolution as
 * this deploy.
 */
function printTryIt(agent: string, config: AgentConfig, callable: boolean): void {
  const { input, filesLeftOut } = exampleInput(config);
  const json = JSON.stringify(input);
  console.log(
    callable
      ? "  Try it — save this input as input.json:"
      : "  Once the version can be called (see above), try it — save this input as input.json:",
  );
  console.log(`    ${json}`);
  console.log("  then run:");
  console.log(`    skrun run ${agent} -f input.json`);
  console.log("  or, in bash or zsh:");
  // Single-quoted for the shell: a quote of the input closes the quoting, is escaped, and reopens it.
  console.log(`    skrun run ${agent} -i '${json.replaceAll("'", "'\\''")}'`);
  for (const name of filesLeftOut) {
    console.log(
      `  Not in this example: "${name}", which takes a file (a file_id, base64 data or a URL).`,
    );
  }
}

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy")
    .description("Deploy agent to Skrun — validate, build, push, get the run URL")
    .option("-m, --message <text>", "Attach a note to this version (max 500 chars, plain text)")
    .action(async (opts: { message?: string }) => {
      const dir = process.cwd();

      // Validate --message client-side
      let notes: string | null = null;
      if (opts.message !== undefined && opts.message !== "") {
        if (opts.message.length > 500) {
          format.error(`--message too long (${opts.message.length} chars). Max 500.`);
          exitWith(1);
        }
        if (opts.message.includes("\x00")) {
          format.error("--message must not contain null bytes.");
          exitWith(1);
        }
        notes = opts.message;
      }

      // 1. The server this deploy goes to, and its session
      const client = connect();

      // 2. Validate
      const result = await validateAgent(dir);
      if (!result.valid) {
        for (const err of result.errors) {
          format.error(`${err.file ?? ""}: ${err.message}`);
        }
        exitWith(1);
      }
      printValidationWarnings(result);

      const config = getValidatedConfig(result);
      const slug = config.name;
      const version = config.version;
      let namespace: string;
      try {
        namespace = await client.currentNamespace();
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }

      // Capability check — refuse before build/push if model can't handle declared media
      const capCheck = validateAgentCapabilities(config);
      if (!capCheck.ok) {
        for (const err of capCheck.errors) format.error(err);
        exitWith(1);
      }

      format.success(`Validated ${namespace}/${slug}`);

      // 3. Build — every time, in this process, by the function `skrun build`
      // runs, from whatever directory the agent is in, and from the validation
      // above. Never a bundle already on disk for this version: it may predate
      // the agent.yaml just validated. (`skrun push` sends what was built.)
      const built = await buildBundle(dir, { validation: result });
      const bundle = readFileSync(built.path);
      format.success(`Built ${built.filename} (${(bundle.length / 1024).toFixed(1)} KB)`);

      // 4. Push
      let versions: string[] = [];
      try {
        const { body, warning } = await client.push(bundle, namespace, slug, version, {
          notes: notes ?? undefined,
        });
        versions = (body.versions as string[] | undefined) ?? [];
        if (warning === "notes-unsupported" && notes) {
          format.warn(
            "Server doesn't support version notes — your message was not stored. Upgrade the registry to use `-m`.",
          );
        }
      } catch (err) {
        format.error(err instanceof Error ? err.message : String(err));
        exitWith(1);
      }
      format.success(`Pushed ${namespace}/${slug}@${version}`);

      // 5. What the server's verification policy makes of the new version —
      // read and said as `skrun push` does. Only `owner` and `disabled` let it
      // be called at once: under `admin`, the first call would be refused.
      const view = await client.verificationView();
      printAfterPushNote(`${namespace}/${slug}@${version}`, version, versions.length === 1, view);

      // 6. Print the run URL — on the server the push went to, by the same resolution.
      const runUrl = `${resolveTarget().address}/api/agents/${namespace}/${slug}/run`;
      const callable = callableAtOnce(view);
      console.log("");
      console.log(
        callable
          ? "  🚀 Deployed! Your agent is live:"
          : "  🚀 Deployed. Your agent's endpoint, once the version can be called (see above):",
      );
      console.log("");
      console.log(`  POST ${runUrl}`);
      // Never the token itself: the output lands in terminals, logs and CI
      // transcripts. A caller of the endpoint substitutes it.
      console.log("  Auth: Bearer <your-token>");
      console.log("");
      // 7. How to try it — through the CLI, which streams the run: what every runtime answers.
      printTryIt(`${namespace}/${slug}`, config, callable);
      console.log("");
    });
}
