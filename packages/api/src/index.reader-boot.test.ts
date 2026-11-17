import type { PathLike } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "./db/memory.js";
import { createApp } from "./index.js";
import { assertAgentYamlWorkerPresent } from "./services/agent-yaml-reader.js";
import { MemoryStorage } from "./storage/memory.js";

// A file can be made to look missing: while `missing.path` ends a path asked
// about, `existsSync` answers false for it. vi.mock is hoisted above every
// import: what its factory reads is declared with vi.hoisted.
const { missing } = vi.hoisted(() => ({ missing: { path: undefined as string | undefined } }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: PathLike) =>
      missing.path !== undefined && String(path).endsWith(missing.path)
        ? false
        : actual.existsSync(path),
  };
});

afterEach(() => {
  missing.path = undefined;
});

const WORKER = "agent-yaml-worker.mjs";

// The module every agent.yaml is read in is copied by the build, not compiled:
// a server without it would answer every push, and each bundle's first run, a
// 500. It refuses to start instead, naming the file.
describe("the reading thread's module, held at startup", () => {
  it("is next to the reader, in src as the build copies it to dist", () => {
    expect(() => assertAgentYamlWorkerPresent()).not.toThrow();
  });

  it("is named when it is missing", () => {
    const url = new URL(`./${WORKER}`, new URL("./services/", import.meta.url));
    missing.path = WORKER;
    expect(() => assertAgentYamlWorkerPresent(url)).toThrow(
      `The agent.yaml reading thread's module is missing: ${fileURLToPath(url)}.`,
    );
  });

  it("refuses to start the server when it is missing", () => {
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).not.toThrow();
    missing.path = WORKER;
    expect(() => createApp(new MemoryStorage(), new MemoryDb())).toThrow(
      /The agent\.yaml reading thread's module is missing: .*agent-yaml-worker\.mjs\./,
    );
  });
});
