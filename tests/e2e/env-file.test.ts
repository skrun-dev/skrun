import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEnvFile } from "./live/env-file.js";

// The live suite's `.env` lives only in the main checkout. From a worktree the
// old `--env-file=.env` died before the first test; this is the resolution that
// replaces it, tested on temp directories so no real checkout is involved.
describe("E2E: live suite .env resolution", () => {
  const roots: string[] = [];
  const mk = (): string => {
    const d = mkdtempSync(join(tmpdir(), "skrun-envfile-"));
    roots.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("falls back to the main checkout's .env from a worktree that has none", () => {
    const main = mk();
    writeFileSync(join(main, ".env"), "A=1\n");
    mkdirSync(join(main, ".git"));
    const worktree = mk();

    expect(resolveEnvFile({ cwd: worktree, gitCommonDir: join(main, ".git") })).toBe(
      join(main, ".env"),
    );
  });

  it("prefers the working directory's own .env when it exists", () => {
    const main = mk();
    writeFileSync(join(main, ".env"), "A=1\n");
    mkdirSync(join(main, ".git"));
    const cwd = mk();
    writeFileSync(join(cwd, ".env"), "A=2\n");

    expect(resolveEnvFile({ cwd, gitCommonDir: join(main, ".git") })).toBe(join(cwd, ".env"));
  });

  it("an explicit override wins over both, even when it does not exist yet", () => {
    const main = mk();
    writeFileSync(join(main, ".env"), "A=1\n");
    const cwd = mk();
    writeFileSync(join(cwd, ".env"), "A=2\n");
    const override = join(mk(), "custom.env");

    expect(resolveEnvFile({ override, cwd, gitCommonDir: join(main, ".git") })).toBe(override);
  });

  it("returns undefined, not an error, when no candidate exists", () => {
    const cwd = mk();
    expect(resolveEnvFile({ cwd })).toBeUndefined();
    expect(resolveEnvFile({ cwd, gitCommonDir: join(mk(), ".git") })).toBeUndefined();
  });
});
