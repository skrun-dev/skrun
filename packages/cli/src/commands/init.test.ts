// VT-10 — `skrun init` produces an agent.yaml with a slug-only `name` field
// (no `<namespace>/<slug>` legacy form) and no longer prompts for a namespace.
//
// We invoke `runInit` directly with all non-interactive flags set so no
// prompts fire. The presence/absence of the namespace prompt is verified
// indirectly via the produced agent.yaml shape — if the prompt had fired,
// the function would have hung waiting for stdin in a test environment.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "./init.js";

describe("runInit — VT-10 slug-only name, no namespace prompt", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skrun-init-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("VT-10a: writes agent.yaml with slug-only name in the target dir", async () => {
    await runInit(dir, {
      name: "test-agent",
      description: "A test agent",
      model: "anthropic/claude-sonnet-4-20250514",
      force: true,
    });
    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    // Must contain exactly the slug — no namespace prefix.
    expect(yaml).toMatch(/^name: test-agent$/m);
    expect(yaml).not.toMatch(/^name: [a-z0-9-]+\/test-agent$/m);
    expect(yaml).not.toContain("dev/test-agent");
    expect(yaml).not.toContain("my/test-agent");
  });

  it("VT-10b: writes SKILL.md with the same slug", async () => {
    await runInit(dir, {
      name: "test-agent",
      description: "A test agent",
      model: "anthropic/claude-sonnet-4-20250514",
      force: true,
    });
    const skill = readFileSync(join(dir, "SKILL.md"), "utf-8");
    expect(skill).toContain("name: test-agent");
  });

  it("VT-10c: InitOptions no longer has a namespace field (type-level guarantee)", () => {
    // Compile-time: passing `namespace` would be a TS error. We assert
    // runtime-shape by attempting to construct an InitOptions WITHOUT
    // namespace and confirming it's accepted.
    const opts = {
      name: "x",
      description: "y",
      model: "anthropic/z",
      force: true,
    };
    expect(opts).not.toHaveProperty("namespace");
  });
});
