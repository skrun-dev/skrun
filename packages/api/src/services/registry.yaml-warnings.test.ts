import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { minimalAgentYaml, validBundle } from "../routes/agent-bundle.shared.js";
import { MemoryStorage } from "../storage/memory.js";
import { RegistryService } from "./registry.js";

// The logger factory is replaced by one that records every call: a case reads
// the lines a push wrote. vi.mock is hoisted above every import: what its
// factory reads is declared with vi.hoisted.
interface LoggedCall {
  level: string;
  args: unknown[];
}

const { logged } = vi.hoisted(() => ({ logged: [] as LoggedCall[] }));

vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const logger = (): unknown => {
    const write =
      (level: string) =>
      (...args: unknown[]) => {
        logged.push({ level, args });
      };
    return {
      trace: write("trace"),
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
      fatal: write("fatal"),
      level: "info",
      child: () => logger(),
    };
  };
  return { ...actual, createLogger: () => logger() };
});

// The yaml library's warnings of a pushed agent.yaml — an unresolved tag,
// say — are one log line at push, with how many and where the first is, its
// code; never a line per warning on the server's error output, and never a
// word of the file: a tag's name is the author's text, of any length.
describe("RegistryService.push — the yaml library's warnings of an agent.yaml", () => {
  let service: RegistryService;
  let emitted: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged.length = 0;
    service = new RegistryService(new MemoryStorage(), new MemoryDb());
    emitted = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  });

  afterEach(() => {
    emitted.mockRestore();
  });

  const warningLines = () =>
    logged.filter(
      ({ args: [fields] }) =>
        (fields as { event?: string } | undefined)?.event === "agent_yaml_warnings",
    );

  it("writes one warn line — the agent, its version, how many, the first one's code and place — and emits none", async () => {
    const secret = `t0${"s".repeat(5_000)}`;
    const tags = Array.from({ length: 500 }, (_, i) => `      - !${i ? `t${i}` : secret} x`).join(
      "\n",
    );
    const yaml = minimalAgentYaml("tagged").replace(
      "  - name: q\n    type: string",
      `  - name: q\n    type: object\n    default:\n${tags}`,
    );
    await service.push("acme", "tagged", "1.0.0", await validBundle("tagged", yaml), "user-1");

    expect(warningLines()).toEqual([
      {
        level: "warn",
        args: [
          {
            event: "agent_yaml_warnings",
            agent: "acme/tagged",
            agent_version: "1.0.0",
            count: 500,
            first_code: "TAG_RESOLVE_FAILED",
            first_line: 10,
            first_column: 9,
          },
          "A pushed agent.yaml reads with YAML warnings",
        ],
      },
    ]);
    expect(JSON.stringify(warningLines())).not.toContain("sss");
    expect(emitted).not.toHaveBeenCalled();
  });

  it("writes none for an agent.yaml the library gives no warning", async () => {
    await service.push("acme", "plain", "1.0.0", await validBundle("plain"), "user-1");
    expect(warningLines()).toEqual([]);
    expect(emitted).not.toHaveBeenCalled();
  });
});
