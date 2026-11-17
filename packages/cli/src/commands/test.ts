import { validateAgent } from "@skrun-dev/schema";
import type { Command } from "commander";
import { evalAssert } from "../utils/assert-eval.js";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { mockRun } from "../utils/mock-runner.js";
import { getValidatedConfig } from "../utils/validated-config.js";
import { printValidationWarnings } from "../utils/validation-output.js";

export function registerTestCommand(program: Command): void {
  program
    .command("test")
    .description("Check tests against simulated outputs (no model call)")
    .action(async () => {
      await runTests();
    });
}

async function runTests(): Promise<void> {
  const dir = process.cwd();

  // Validate agent
  const result = await validateAgent(dir);
  if (!result.valid) {
    for (const err of result.errors) {
      format.error(`${err.file ?? ""}: ${err.message}`);
    }
    format.error("Fix errors before testing.");
    exitWith(1);
  }
  printValidationWarnings(result);

  const config = getValidatedConfig(result);
  const tests = config.tests;

  if (tests.length === 0) {
    format.info("No tests defined in agent.yaml. Add tests to the 'tests' section.");
    exitWith(0);
  }

  format.info(`Running ${tests.length} test(s) for ${config.name}...`);
  format.info(
    "Outputs are simulated — no model is called. Each test checks that its input carries each " +
      "input the agent requires — null, or an empty list for a file input, counts as missing —, " +
      "then its assertion against placeholder outputs. For a real run: skrun deploy, then skrun run.",
  );

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      // Run mock execution
      const runResult = mockRun(config, test.input as Record<string, unknown>);

      // Evaluate assertion
      const assertResult = evalAssert(test.assert, runResult.output);

      if (assertResult.pass) {
        format.success(`${test.name} ${format.dim(`(${assertResult.detail})`)}`);
        passed++;
      } else {
        format.error(`${test.name}`);
        console.log(`  ${assertResult.detail}`);
        failed++;
      }
    } catch (err) {
      format.error(`${test.name}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log("");
  if (failed === 0) {
    format.success(`${passed} passed, ${failed} failed`);
  } else {
    format.error(`${passed} passed, ${failed} failed`);
  }

  exitWith(failed > 0 ? 1 : 0);
}
