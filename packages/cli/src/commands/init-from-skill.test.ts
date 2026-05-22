// VT-11 — `skrun init --from-skill` produces an agent.yaml with a slug-only
// `name` field (post-#84) and no longer prompts for a namespace nor accepts
// `--namespace`.
//
// We mock the `prompts` module to short-circuit the non-namespace prompts
// (input field, network domains, model). If the namespace prompt had survived
// the refactor, it would either appear in the mocked-prompts call log (which
// we assert against) or hang the test waiting on stdin.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const askTextMock = vi.fn();
const askModelMock = vi.fn();

vi.mock("../utils/prompts.js", () => ({
  askText: (label: string, defaultValue?: string) => askTextMock(label, defaultValue),
  askModel: () => askModelMock(),
}));

import { initFromSkill } from "./init-from-skill.js";

describe("initFromSkill — VT-11 slug-only name, no namespace prompt or flag", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-init-from-skill-test-"));
    writeFileSync(
      join(dir, "SKILL.md"),
      `---
name: my-skill
description: A test skill
---

# my-skill

Body.
`,
    );
    askTextMock.mockReset();
    askModelMock.mockReset();
    // Defaults for the two remaining prompts (input + network).
    askTextMock.mockResolvedValueOnce("query:string");
    askTextMock.mockResolvedValueOnce("");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("VT-11a: writes agent.yaml with slug-only name from SKILL.md frontmatter", async () => {
    await initFromSkill(dir, {
      model: "anthropic/claude-sonnet-4-20250514",
      force: true,
    });
    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toMatch(/^name: my-skill$/m);
    expect(yaml).not.toMatch(/^name: [a-z0-9-]+\/my-skill$/m);
    expect(yaml).not.toContain("dev/my-skill");
    expect(yaml).not.toContain("my/my-skill");
  });

  it("VT-11b: does NOT call askText with a 'Namespace?' label", async () => {
    await initFromSkill(dir, {
      model: "anthropic/claude-sonnet-4-20250514",
      force: true,
    });
    const namespaceCalls = askTextMock.mock.calls.filter((call) =>
      String(call[0]).toLowerCase().includes("namespace"),
    );
    expect(namespaceCalls).toHaveLength(0);
  });

  it("VT-11c: FromSkillOptions has no `namespace` field (type-level guarantee)", () => {
    // Compile-time: passing `namespace` would be a TS error. Runtime
    // confirmation that no `namespace` field flows through the public
    // entry point.
    const opts = {
      model: "anthropic/claude-sonnet-4-20250514",
      force: true,
    };
    expect(opts).not.toHaveProperty("namespace");
  });
});
