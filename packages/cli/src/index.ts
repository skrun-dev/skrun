import { buildProgram } from "./program.js";
import { runCli } from "./utils/exit.js";

// The process ends on its own, with the exit code the command left.
void runCli(buildProgram());
