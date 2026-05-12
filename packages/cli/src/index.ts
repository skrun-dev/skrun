import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerBuildCommand } from "./commands/build.js";
import { registerCacheCommand } from "./commands/cache.js";
import { registerDeployCommand } from "./commands/deploy.js";
import { registerDevCommand } from "./commands/dev.js";
import { registerInitCommand } from "./commands/init.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerLogoutCommand } from "./commands/logout.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerPullCommand } from "./commands/pull.js";
import { registerPushCommand } from "./commands/push.js";
import { registerTestCommand } from "./commands/test.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  version: string;
};

const program = new Command();

program
  .name("skrun")
  .description("Deploy any Agent Skill as an API — The Vercel for Agent Skills")
  .version(pkg.version);

registerInitCommand(program);
registerDevCommand(program);
registerTestCommand(program);
registerBuildCommand(program);
registerLoginCommand(program);
registerLogoutCommand(program);
registerPushCommand(program);
registerPullCommand(program);
registerDeployCommand(program);
registerLogsCommand(program);
registerCacheCommand(program);

program.parse();
