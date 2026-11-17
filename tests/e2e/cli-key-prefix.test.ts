import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_KEY_PREFIX, RETIRED_API_KEY_PREFIX } from "../../packages/api/src/auth/api-key.js";
import { registerLoginCommand } from "../../packages/cli/src/commands/login.js";

/**
 * The CLI does not depend on the API package, so its `skrun login --token` help
 * spells the start of a key as a literal. This file holds that literal to the
 * one definition: it registers the real `login` command on a commander program
 * — commander resolved from the CLI package, as the CLI itself resolves it — and
 * reads the description of `--token`. A prefix changed on one side only turns
 * this red.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type LoginProgram = Parameters<typeof registerLoginCommand>[0];

interface Option {
  long?: string;
  description: string;
}

interface Program {
  commands: Array<{ name(): string; options: readonly Option[] }>;
}

const { Command } = createRequire(join(ROOT, "packages/cli/package.json"))("commander") as {
  Command: new () => Program;
};

describe("skrun login", () => {
  it("the login help shows the current key prefix", () => {
    const program = new Command();
    registerLoginCommand(program as unknown as LoginProgram);

    const login = program.commands.find((command) => command.name() === "login");
    const token = login?.options.find((option) => option.long === "--token");

    expect(token, "the login command has a --token option").toBeDefined();
    expect(token?.description).toContain(API_KEY_PREFIX);
    expect(token?.description).not.toContain(RETIRED_API_KEY_PREFIX);
  });
});
