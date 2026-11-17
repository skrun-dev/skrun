/**
 * E2E: every demo agent under `agents/` passes the validation `skrun build`,
 * `push`, `deploy`, `dev` and `test` run — no error, no warning about its
 * state, and no retired field. Nothing else validates the demos outside the
 * live suite, and their `state` block is the part whose defaults and bounds
 * change. A demo is what an author copies: it declares nothing that no code
 * honours — neither `filesystem` (retired) nor a `secrets` list.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateAgent } from "../../packages/schema/src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS_DIR = join(ROOT, "agents");
const DEMOS = readdirSync(AGENTS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("E2E: the demo agents validate", () => {
  it("finds the demos", () => {
    expect(DEMOS.length).toBeGreaterThan(0);
  });

  for (const demo of DEMOS) {
    it(`${demo} validates, with no warning about its state nor a retired field, and declares neither filesystem nor secrets`, async () => {
      const result = await validateAgent(join(AGENTS_DIR, demo));
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
      const stateWarnings = result.warnings.filter((w) => /STATE/i.test(w.code));
      expect(stateWarnings).toEqual([]);
      const retired = result.warnings.filter((w) => w.code === "RETIRED_FIELD");
      expect(retired).toEqual([]);
      const raw = readFileSync(join(AGENTS_DIR, demo, "agent.yaml"), "utf-8");
      const declared = raw
        .split(/\r?\n/)
        .filter((line) => /^\s*(filesystem|secrets)\s*:/.test(line));
      expect(declared).toEqual([]);
    });
  }

  it("each demo that keeps state keeps one notebook per caller", async () => {
    const stateful: string[] = [];
    for (const demo of DEMOS) {
      const result = await validateAgent(join(AGENTS_DIR, demo));
      const state = result.parsed?.agentConfig.config.state;
      if (state?.type === "kv") {
        stateful.push(demo);
        expect(state.scope, demo).toBe("per_caller");
      }
    }
    // Not vacuous: the demos do include stateful ones.
    expect(stateful.length).toBeGreaterThan(0);
  });
});
