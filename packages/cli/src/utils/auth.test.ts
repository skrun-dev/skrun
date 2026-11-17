import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ThrowawayProfile,
  useThrowawayProfile,
  writeSession,
  writeSignInFile,
} from "../test-profile.shared.js";
import {
  checkToken,
  DEFAULT_REGISTRY_URL,
  InvalidRegistryUrl,
  isLoopback,
  NotSignedIn,
  normalizeRegistryUrl,
  parseSessionFile,
  RedirectRefused,
  removeOlderConfig,
  removeSession,
  resolveTarget,
  type SessionFile,
  SignInFileNotRead,
  SignInFileNotWritten,
  saveSession,
  send,
  serializeSessionFile,
  Unreachable,
} from "./auth.js";

// The functions of node:fs that read, write and remove the sign-in file,
// wrapped: the real function runs, and every call — the module under test's
// own, through its named imports — is recorded, options included. A final
// `stat` cannot tell a file created 0600 from one created 0644 and narrowed by
// chmod a moment later.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    chmodSync: vi.fn(real.chmodSync),
    mkdirSync: vi.fn(real.mkdirSync),
    readFileSync: vi.fn(real.readFileSync),
    renameSync: vi.fn(real.renameSync),
    rmSync: vi.fn(real.rmSync),
    writeFileSync: vi.fn(real.writeFileSync),
  };
});

beforeEach(() => {
  vi.stubEnv("SKRUN_REGISTRY_URL", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The sign-in file of a profile, read back as the CLI reads it. */
function readBack(profile: ThrowawayProfile): ReturnType<typeof parseSessionFile> {
  return parseSessionFile(readFileSync(profile.file, "utf-8"));
}

describe("a server address", () => {
  it.each([
    ["HTTPS://Example.com:443/", "https://example.com"],
    ["http://localhost:4000/", "http://localhost:4000"],
    ["http://localhost:4000", "http://localhost:4000"],
    ["https://skrun.example.com/base//", "https://skrun.example.com/base"],
    ["http://EXAMPLE.com:80", "http://example.com"],
    ["https://example.com:8443", "https://example.com:8443"],
  ])("%s is stored, printed and compared as %s", (raw, normalized) => {
    expect(normalizeRegistryUrl(raw, "--registry")).toBe(normalized);
  });

  it.each([
    ["a scheme other than http or https", "ftp://x"],
    ["a user name and a password", "https://u:p@x"],
    ["a password with an empty user name", "https://:p@x"],
    ["no scheme", "example.com"],
    ["a query", "https://x/?a=1"],
    ["an empty query", "https://x/?"],
    ["a fragment", "https://x/#f"],
    ["an empty fragment", "https://x/#"],
  ])("an address with %s is refused (%s)", (_what, raw) => {
    let caught: unknown;
    try {
      normalizeRegistryUrl(raw, "--registry");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidRegistryUrl);
    expect((caught as Error).message).toBe(
      "--registry must be an absolute http:// or https:// address, with no user name, password, query or fragment — for example https://skrun.example.com",
    );
  });

  it("the refusal does not repeat the value, which can carry a password", () => {
    let caught: unknown;
    try {
      normalizeRegistryUrl("https://someone:witness-secret-4f2a@x", "--registry");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidRegistryUrl);
    expect((caught as Error).message).not.toContain("witness-secret-4f2a");
  });

  it("the refusal names where the value came from", () => {
    expect(() => normalizeRegistryUrl("ftp://x", "SKRUN_REGISTRY_URL")).toThrow(
      /^SKRUN_REGISTRY_URL must be an absolute http:\/\/ or https:\/\/ address/,
    );
  });
});

describe("a loopback address", () => {
  it.each([
    "http://localhost:4000",
    "http://127.0.0.1:4000",
    "http://127.1.2.3",
    "http://[::1]:4000",
    "http://127.1",
  ])("%s designates this machine", (address) => {
    expect(isLoopback(address)).toBe(true);
  });

  it.each([
    "http://192.168.1.10:4000",
    "https://example.com",
    "http://localhost.example.com",
    "http://127.0.0.1.example.com",
  ])("%s does not", (address) => {
    expect(isLoopback(address)).toBe(false);
  });

  it("127.1 is read as 127.0.0.1", () => {
    expect(normalizeRegistryUrl("http://127.1:4000", "--registry")).toBe("http://127.0.0.1:4000");
  });
});

describe("reading the sign-in file", () => {
  const twoSessions: SessionFile = {
    version: 2,
    current: "https://a.example",
    sessions: {
      "https://a.example": { token: "token-a", username: "alice" },
      "http://localhost:4000": { token: "dev-token" },
    },
  };

  it("a file of this CLI gives its sessions and its current server", () => {
    expect(parseSessionFile(JSON.stringify(twoSessions))).toEqual({
      kind: "sessions",
      file: twoSessions,
    });
  });

  it("what the CLI writes is what it reads back", () => {
    const text = serializeSessionFile(twoSessions);
    expect(text.startsWith('{\n  "version": 2,\n  "current": "https://a.example",\n')).toBe(true);
    expect(parseSessionFile(text)).toEqual({ kind: "sessions", file: twoSessions });
  });

  it("a file with no current server is read as such", () => {
    const noCurrent: SessionFile = {
      version: 2,
      sessions: { "https://b.example": { token: "t" } },
    };
    expect(serializeSessionFile(noCurrent)).not.toContain("current");
    expect(parseSessionFile(serializeSessionFile(noCurrent))).toEqual({
      kind: "sessions",
      file: noCurrent,
    });
  });

  it.each([
    ["a token alone", '{"token":"older-token"}'],
    ["a token and a username", '{"token":"older-token","username":"bob"}'],
    ["a token and a registry_url", '{"token":"older-token","registry_url":"https://x.example"}'],
    ["an empty object", "{}"],
  ])("an older CLI's file (%s) is recognized, and gives no session", (_what, text) => {
    expect(parseSessionFile(text)).toEqual({ kind: "older" });
  });

  it.each([
    ["text that is not JSON", '{"version": 2, "sessions": {'],
    ["an empty file", ""],
    ["an array", "[]"],
    ["null", "null"],
    ["a number", "42"],
    ["a string", '"skrun_sk_x"'],
    ["sessions that are not an object", '{"version":2,"sessions":"skrun_sk_x"}'],
    ["sessions that are an array", '{"version":2,"sessions":[]}'],
    ["no sessions at all", '{"version":2}'],
    [
      "a session with an empty token",
      '{"version":2,"sessions":{"https://a.example":{"token":""}}}',
    ],
    [
      "a session under a key that is not an address",
      '{"version":2,"sessions":{"ftp://a":{"token":"t"}}}',
    ],
    ["a current server that is not an address", '{"version":2,"current":"nowhere","sessions":{}}'],
  ])("a file that cannot be read (%s) is recognized, and gives no session", (_what, text) => {
    expect(parseSessionFile(text)).toEqual({ kind: "unreadable" });
  });
});

describe("which server a command talks to", () => {
  const OPTION = "https://option.example";
  const VARIABLE = "https://variable.example";
  const CURRENT = "https://current.example";

  function arrange(setup: { variable?: boolean; current?: boolean }): void {
    const profile = useThrowawayProfile();
    if (setup.current) writeSession(profile, { address: CURRENT, token: "token-current" });
    if (setup.variable) vi.stubEnv("SKRUN_REGISTRY_URL", VARIABLE);
  }

  type Who = "a command" | "the browser sign-in" | "a typed token";
  const DEFAULT = DEFAULT_REGISTRY_URL;

  it.each([
    ["a command", false, false, false, "default", DEFAULT],
    ["a command", false, false, true, "session", CURRENT],
    ["a command", false, true, false, "env", VARIABLE],
    ["a command", false, true, true, "env", VARIABLE],
    ["the browser sign-in", false, false, false, "default", DEFAULT],
    ["the browser sign-in", false, false, true, "session", CURRENT],
    ["the browser sign-in", false, true, false, "env", VARIABLE],
    ["the browser sign-in", false, true, true, "env", VARIABLE],
    ["the browser sign-in", true, false, false, "option", OPTION],
    ["the browser sign-in", true, false, true, "option", OPTION],
    ["the browser sign-in", true, true, false, "option", OPTION],
    ["the browser sign-in", true, true, true, "option", OPTION],
    ["a typed token", false, false, false, "default", DEFAULT],
    ["a typed token", false, false, true, "default", DEFAULT],
    ["a typed token", false, true, false, "env", VARIABLE],
    ["a typed token", false, true, true, "env", VARIABLE],
    ["a typed token", true, false, false, "option", OPTION],
    ["a typed token", true, false, true, "option", OPTION],
    ["a typed token", true, true, false, "option", OPTION],
    ["a typed token", true, true, true, "option", OPTION],
  ] as const)("%s — option %s, variable %s, current server %s: the %s address (%s)", (who: Who, option, variable, current, source, address) => {
    arrange({ variable, current });
    const typedToken = who === "a typed token";
    expect(resolveTarget({ registry: option ? OPTION : undefined, typedToken })).toEqual({
      address,
      source,
    });
  });

  it.each(["", "   "])("a variable set to %j counts as not set", (blank) => {
    arrange({ current: true });
    vi.stubEnv("SKRUN_REGISTRY_URL", blank);
    expect(resolveTarget()).toEqual({ address: CURRENT, source: "session" });
  });

  it("an invalid variable is refused, naming SKRUN_REGISTRY_URL", () => {
    arrange({ current: true });
    vi.stubEnv("SKRUN_REGISTRY_URL", "ftp://variable.example");
    expect(() => resolveTarget()).toThrow(InvalidRegistryUrl);
    expect(() => resolveTarget()).toThrow(/^SKRUN_REGISTRY_URL must be an absolute/);
  });

  it("an invalid option is refused, naming --registry", () => {
    arrange({ variable: true });
    expect(() => resolveTarget({ registry: "registry.example" })).toThrow(
      /^--registry must be an absolute/,
    );
  });

  it("the option and the variable are given in their normalized form", () => {
    arrange({});
    expect(resolveTarget({ registry: "HTTPS://Option.Example:443/" }).address).toBe(OPTION);
    vi.stubEnv("SKRUN_REGISTRY_URL", "https://VARIABLE.example/");
    expect(resolveTarget().address).toBe(VARIABLE);
  });

  it.each([
    ["an older CLI's file", '{"token":"older-token","registry_url":"https://current.example"}'],
    ["a file that cannot be read", '{"version":2,"current":"https://current.example"}'],
  ])("%s has no current server: the default", (_what, text) => {
    writeSignInFile(useThrowawayProfile(), text);
    expect(resolveTarget()).toEqual({ address: DEFAULT_REGISTRY_URL, source: "default" });
  });
});

describe("a session is found by its server address, whatever form it was written in", () => {
  it("a session stored under http://a.example/ is the one a sign-in to http://a.example replaces", () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: "http://a.example/", token: "token-old" });
    saveSession("http://a.example", "token-new", "alice", { makeCurrent: false });
    const read = readBack(profile);
    expect(read.kind === "sessions" && read.file.sessions).toEqual({
      "http://a.example": { token: "token-new", username: "alice" },
    });
  });

  it("and the session stored under http://a.example is the one a sign-in to http://a.example/ replaces", () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: "http://a.example", token: "token-old" });
    saveSession("http://a.example/", "token-new", undefined, { makeCurrent: false });
    const read = readBack(profile);
    expect(read.kind === "sessions" && read.file.sessions).toEqual({
      "http://a.example": { token: "token-new" },
    });
  });

  it("removing the session of http://a.example removes the one stored under http://a.example/, and clears it as the current server", () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: "http://a.example/", token: "token-a" });
    expect(removeSession("http://a.example")).toBe(true);
    expect(readBack(profile)).toEqual({ kind: "sessions", file: { version: 2, sessions: {} } });
  });
});

describe("saving and removing sessions", () => {
  const A = "https://a.example";
  const B = "https://b.example";

  it("a sign-in that makes its server current", () => {
    const profile = useThrowawayProfile();
    saveSession(A, "token-a", "alice", { makeCurrent: true });
    expect(readBack(profile)).toEqual({
      kind: "sessions",
      file: { version: 2, current: A, sessions: { [A]: { token: "token-a", username: "alice" } } },
    });
  });

  it("a sign-in that leaves the current server as it is keeps the other sessions", () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-a", username: "alice" });
    saveSession(B, "token-b", undefined, { makeCurrent: false });
    expect(readBack(profile)).toEqual({
      kind: "sessions",
      file: {
        version: 2,
        current: A,
        sessions: { [A]: { token: "token-a", username: "alice" }, [B]: { token: "token-b" } },
      },
    });
  });

  it("a sign-in with no current server written leaves none", () => {
    const profile = useThrowawayProfile();
    saveSession(B, "token-b", undefined, { makeCurrent: false });
    expect(readBack(profile)).toEqual({
      kind: "sessions",
      file: { version: 2, sessions: { [B]: { token: "token-b" } } },
    });
  });

  it("a new session of a server drops the namespace the old one had", () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-a", username: "alice" });
    saveSession(A, "dev-token", undefined, { makeCurrent: true });
    const read = readBack(profile);
    expect(read.kind === "sessions" && read.file.sessions[A]).toEqual({ token: "dev-token" });
  });

  it.each([
    ["an older CLI's file", { token: "older-token", username: "bob" }],
    ["a file that cannot be read", "{ not json"],
  ])("a sign-in replaces %s", (_what, content) => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, content);
    saveSession(A, "token-a", undefined, { makeCurrent: true });
    expect(readBack(profile)).toEqual({
      kind: "sessions",
      file: { version: 2, current: A, sessions: { [A]: { token: "token-a" } } },
    });
  });

  it("removing another server's session leaves the current server and its session", () => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, {
      version: 2,
      current: A,
      sessions: { [A]: { token: "token-a" }, [B]: { token: "token-b" } },
    });
    expect(removeSession(B)).toBe(true);
    expect(readBack(profile)).toEqual({
      kind: "sessions",
      file: { version: 2, current: A, sessions: { [A]: { token: "token-a" } } },
    });
  });

  it("removing the current server's session clears the current server, and makes no other one current", () => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, {
      version: 2,
      current: A,
      sessions: { [A]: { token: "token-a" }, [B]: { token: "token-b" } },
    });
    expect(removeSession(A)).toBe(true);
    expect(readBack(profile)).toEqual({
      kind: "sessions",
      file: { version: 2, sessions: { [B]: { token: "token-b" } } },
    });
  });

  it.each([
    ["a server with no session", { version: 2, current: A, sessions: { [A]: { token: "t" } } }],
    ["an older CLI's file", { token: "older-token" }],
    ["a file that cannot be read", "[]"],
  ])("removing the session of %s removes nothing, and writes nothing", (_what, content) => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, content);
    const before = readFileSync(profile.file);
    expect(removeSession(B)).toBe(false);
    expect(readFileSync(profile.file).equals(before)).toBe(true);
  });

  it.each([
    ["an older CLI's file", { token: "older-token", registry_url: A }],
    ["a file that cannot be read", "{ not json"],
  ])("%s is removed whole by removeOlderConfig", (_what, content) => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, content);
    expect(removeOlderConfig()).toBe(true);
    expect(readdirSync(profile.dir)).toEqual([]);
  });

  it("a file of this CLI is left as it is by removeOlderConfig", () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-a" });
    const before = readFileSync(profile.file);
    expect(removeOlderConfig()).toBe(false);
    expect(readFileSync(profile.file).equals(before)).toBe(true);
  });
});

describe("writing the sign-in file", () => {
  const A = "https://a.example";
  const TEMPORARY = /^\.config\.json\.(\d+)\.([0-9a-f]+)\.tmp$/;

  /** The calls of a wrapped function that touched the profile's CLI directory. */
  function callsInto(fn: unknown, profile: ThrowawayProfile): unknown[][] {
    return vi
      .mocked(fn as (...args: unknown[]) => unknown)
      .mock.calls.filter(([path]) => typeof path === "string" && path.startsWith(profile.dir));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A case that makes the rename or the removal fail leaves no failure queued for the next one.
  afterEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockReset();
    vi.mocked(renameSync).mockImplementation(actual.renameSync);
    vi.mocked(rmSync).mockReset();
    vi.mocked(rmSync).mockImplementation(actual.rmSync);
  });

  it("the text goes to a temporary file of the same directory, under a unique name, created exclusively for its owner only, then renamed over the old one", () => {
    const profile = useThrowawayProfile();
    vi.clearAllMocks();
    saveSession(A, "token-a", undefined, { makeCurrent: true });

    const writes = callsInto(writeFileSync, profile);
    expect(writes).toHaveLength(1);
    const [temporary, , options] = writes[0] as [string, string, unknown];
    expect(dirname(temporary)).toBe(profile.dir);
    expect(basename(temporary)).toMatch(TEMPORARY);
    expect(basename(temporary).match(TEMPORARY)?.[1]).toBe(String(process.pid));
    expect(options).toEqual(expect.objectContaining({ mode: 0o600, flag: "wx" }));

    expect(callsInto(renameSync, profile)).toEqual([[temporary, profile.file]]);
    expect(callsInto(chmodSync, profile).filter(([path]) => path !== profile.dir)).toEqual([]);
    expect(readdirSync(profile.dir)).toEqual(["config.json"]);
    expect(readBack(profile).kind).toBe("sessions");
  });

  it("two writes use two temporary names", () => {
    const profile = useThrowawayProfile();
    vi.clearAllMocks();
    saveSession(A, "token-1", undefined, { makeCurrent: true });
    saveSession(A, "token-2", undefined, { makeCurrent: true });
    const names = callsInto(writeFileSync, profile).map(([path]) => path);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
  });

  it("the directory is created for its owner only", () => {
    const profile = useThrowawayProfile();
    vi.clearAllMocks();
    saveSession(A, "token-a", undefined, { makeCurrent: true });
    expect(callsInto(mkdirSync, profile)).toEqual([
      [profile.dir, expect.objectContaining({ recursive: true, mode: 0o700 })],
    ]);
  });

  it("a directory that already exists is narrowed to its owner", () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-old" });
    vi.clearAllMocks();
    saveSession(A, "token-a", undefined, { makeCurrent: true });
    expect(callsInto(chmodSync, profile)).toEqual([[profile.dir, 0o700]]);
  });

  /** Run `body` as if on `platform`, then put the real one back. */
  function onPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
    const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      return body();
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  }

  /** A rename that throws as Node does, with `code`. */
  const refused = (code: string) => (): never => {
    throw Object.assign(new Error(`rename refused (simulated, ${code})`), { code });
  };

  /** What `body` throws; undefined when it throws nothing. */
  function thrownBy(body: () => void): unknown {
    try {
      body();
    } catch (err) {
      return err;
    }
    return undefined;
  }

  it("a rename that fails leaves the old file whole, and no temporary file behind; the error names its code, never the file", () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-old", username: "alice" });
    const before = readFileSync(profile.file);
    vi.clearAllMocks();
    vi.mocked(renameSync).mockImplementationOnce(refused("EIO"));

    const err = onPlatform("win32", () =>
      thrownBy(() => saveSession(A, "token-new", undefined, { makeCurrent: true })),
    );

    expect(callsInto(renameSync, profile)).toHaveLength(1);
    expect((err as Error | undefined)?.message).toBe(
      "Could not write the CLI's sign-in file (EIO): it is in use, or cannot be written. It is left as it was — try again.",
    );
    expect(err).toBeInstanceOf(SignInFileNotWritten);
    expect(readFileSync(profile.file).equals(before)).toBe(true);
    expect(readdirSync(profile.dir)).toEqual(["config.json"]);
  });

  it("a rename that fails, then a temporary file that cannot be removed: the error is still the sign-in file's, with the rename's code — never the removal's error, nor the file's path; the old file whole, the temporary file left", () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-old", username: "alice" });
    const before = readFileSync(profile.file);
    vi.clearAllMocks();
    vi.mocked(renameSync).mockImplementationOnce(refused("EIO"));
    vi.mocked(rmSync).mockImplementationOnce((path) => {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${String(path)}'`), {
        code: "EBUSY",
      });
    });

    const err = thrownBy(() => saveSession(A, "token-new", undefined, { makeCurrent: true }));

    expect((err as Error | undefined)?.message).toBe(
      "Could not write the CLI's sign-in file (EIO): it is in use, or cannot be written. It is left as it was — try again.",
    );
    expect(err).toBeInstanceOf(SignInFileNotWritten);
    expect(callsInto(rmSync, profile)).toHaveLength(1);
    expect(readFileSync(profile.file).equals(before)).toBe(true);
    const left = readdirSync(profile.dir).filter((name) => name !== "config.json");
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(TEMPORARY);
  });

  it.each([
    "EPERM",
    "EACCES",
    "EBUSY",
  ])("on Windows, a rename refused twice with %s, then accepted, is tried again: the session is saved", (code) => {
    const profile = useThrowawayProfile();
    const B = "https://b.example";
    writeSession(profile, { address: A, token: "token-a" });
    vi.clearAllMocks();
    vi.mocked(renameSync)
      .mockImplementationOnce(refused(code))
      .mockImplementationOnce(refused(code));

    const err = onPlatform("win32", () =>
      thrownBy(() => saveSession(B, "token-b", "bob", { makeCurrent: false })),
    );

    expect(err).toBeUndefined();
    expect(callsInto(renameSync, profile)).toHaveLength(3);
    expect(readBack(profile)).toEqual({
      kind: "sessions",
      file: {
        version: 2,
        current: A,
        sessions: { [A]: { token: "token-a" }, [B]: { token: "token-b", username: "bob" } },
      },
    });
    expect(readdirSync(profile.dir)).toEqual(["config.json"]);
  });

  it("on Windows, a rename refused every time is tried again for two seconds, then fails: the old file whole, no temporary file, the error without the file's path", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-old", username: "alice" });
    const before = readFileSync(profile.file);
    vi.clearAllMocks();
    vi.mocked(renameSync).mockImplementation(refused("EPERM"));
    const started = Date.now();

    const err = onPlatform("win32", () =>
      thrownBy(() => saveSession(A, "token-new", undefined, { makeCurrent: true })),
    );
    const elapsed = Date.now() - started;

    expect(callsInto(renameSync, profile).length).toBeGreaterThan(2);
    expect((err as Error | undefined)?.message).toBe(
      "Could not write the CLI's sign-in file (EPERM): it is in use, or cannot be written. It is left as it was — try again.",
    );
    expect(err).toBeInstanceOf(SignInFileNotWritten);
    expect((err as Error | undefined)?.message).not.toContain(profile.home);
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(10_000);
    expect(readFileSync(profile.file).equals(before)).toBe(true);
    expect(readdirSync(profile.dir)).toEqual(["config.json"]);
  }, 20_000);

  it("elsewhere than Windows, a refused rename is not tried again", () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-old" });
    const before = readFileSync(profile.file);
    vi.clearAllMocks();
    vi.mocked(renameSync).mockImplementationOnce(refused("EPERM"));

    const err = onPlatform("linux", () =>
      thrownBy(() => saveSession(A, "token-new", undefined, { makeCurrent: true })),
    );

    expect(callsInto(renameSync, profile)).toHaveLength(1);
    expect((err as Error | undefined)?.message).toBe(
      "Could not write the CLI's sign-in file (EPERM): it is in use, or cannot be written. It is left as it was — try again.",
    );
    expect(err).toBeInstanceOf(SignInFileNotWritten);
    expect(readFileSync(profile.file).equals(before)).toBe(true);
    expect(readdirSync(profile.dir)).toEqual(["config.json"]);
  });

  it.skipIf(process.platform === "win32")(
    "on POSIX, the directory is 0700 and the file 0600 (skipped on Windows, where these modes have no effect)",
    () => {
      const profile = useThrowawayProfile();
      saveSession(A, "token-a", undefined, { makeCurrent: true });
      expect(statSync(profile.dir).mode & 0o777).toBe(0o700);
      expect(statSync(profile.file).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "on POSIX, a directory an older CLI left at 0755 is narrowed to 0700 (skipped on Windows, where these modes have no effect)",
    () => {
      const profile = useThrowawayProfile();
      mkdirSync(profile.dir, { mode: 0o755 });
      chmodSync(profile.dir, 0o755);
      saveSession(A, "token-a", undefined, { makeCurrent: true });
      expect(statSync(profile.dir).mode & 0o777).toBe(0o700);
      expect(statSync(profile.file).mode & 0o777).toBe(0o600);
    },
  );
});

describe("a sign-in file the system does not let the CLI read", () => {
  const A = "https://a.example";

  afterEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(readFileSync).mockReset();
    vi.mocked(readFileSync).mockImplementation(actual.readFileSync);
    vi.unstubAllGlobals();
  });

  it("held by another program (EBUSY, as Windows refuses a file opened without sharing): saving a session, sending a request and resolving the current server each fail with the code, never the file's path; nothing is sent, the file is left whole", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-a", username: "alice" });
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const before = actual.readFileSync(profile.file);
    vi.mocked(readFileSync).mockImplementation(((path: unknown, ...rest: unknown[]) => {
      if (path === profile.file) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${profile.file}'`), {
          code: "EBUSY",
        });
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof readFileSync);
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        sent.push(String(input));
        return Response.json({});
      }),
    );
    const thrown = (body: () => unknown): unknown => {
      try {
        body();
      } catch (err) {
        return err;
      }
      return undefined;
    };

    const errors = [
      thrown(() => saveSession(A, "token-new", undefined, { makeCurrent: true })),
      await send(A, "/api/keys", {}, "session").catch((e: unknown) => e),
      thrown(() => resolveTarget()),
    ];

    expect(errors.map((err) => (err as Error | undefined)?.message)).toEqual(
      Array(3).fill(
        "Could not read the CLI's sign-in file (EBUSY): it is in use, or cannot be read. It is left as it was — try again.",
      ),
    );
    for (const err of errors) expect(err).toBeInstanceOf(SignInFileNotRead);
    expect(sent).toEqual([]);
    expect(actual.readFileSync(profile.file).equals(before)).toBe(true);
  });
});

describe("sending a request to a server", () => {
  const A = "https://a.example";
  const B = "https://b.example";

  interface Sent {
    url: string;
    init: RequestInit;
  }

  /** Replace fetch by a recorder that answers with `respond`. */
  function recordRequests(respond: () => Response = () => Response.json({})): Sent[] {
    const sent: Sent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(input), init: init ?? {} });
        return respond();
      }),
    );
    return sent;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a request under a session carries the token saved for that server, and no other", async () => {
    const profile = useThrowawayProfile();
    writeSignInFile(profile, {
      version: 2,
      current: B,
      sessions: { [A]: { token: "token-a" }, [B]: { token: "token-b" } },
    });
    const sent = recordRequests();

    await send(A, "/api/keys", { method: "GET" }, "session");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${A}/api/keys`);
    expect(sent[0]?.init.headers).toEqual({ Authorization: "Bearer token-a" });
  });

  it("a request without a session carries no token, even to a server that has one", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-a" });
    const sent = recordRequests();

    await send(A, "/auth/device/code", { method: "POST", body: "{}" }, "none");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.init.headers).toEqual({});
  });

  it("an Authorization header the caller gives is never sent", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-a" });
    const sent = recordRequests();
    const headers = { authorization: "Bearer someone-else", "Content-Type": "application/json" };

    await send(A, "/x", { headers }, "session");
    await send(A, "/x", { headers }, "none");

    expect(sent.map((s) => s.init.headers)).toEqual([
      { "Content-Type": "application/json", Authorization: "Bearer token-a" },
      { "Content-Type": "application/json" },
    ]);
  });

  it("no redirect is followed, whatever the caller asks", async () => {
    useThrowawayProfile();
    const sent = recordRequests();

    await send(A, "/x", { redirect: "follow" }, "none");

    expect(sent[0]?.init.redirect).toBe("manual");
  });

  it.each([
    [
      "no session for that server",
      { version: 2, sessions: { [B]: { token: "token-b" } } },
      `Not logged in to ${A}. Sign in: skrun login --registry ${A}`,
    ],
    [
      "an older CLI's file",
      { token: "older-token", registry_url: A },
      "Signed in with an older CLI — sign in again: skrun login --registry <url>",
    ],
    [
      "a file that cannot be read",
      "{ not json",
      "The CLI's sign-in file cannot be read — sign in again: skrun login --registry <url>",
    ],
  ])("%s: nothing is sent, and the message says how to sign in", async (_what, content, message) => {
    writeSignInFile(useThrowawayProfile(), content);
    const sent = recordRequests();

    const err = await send(A, "/api/keys", {}, "session").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotSignedIn);
    expect((err as Error).message).toBe(message);
    expect(sent).toEqual([]);
  });

  it("no session for a server SKRUN_REGISTRY_URL names: the sign-in it advises names no address, which would make that server the current one", async () => {
    writeSignInFile(useThrowawayProfile(), { version: 2, sessions: { [B]: { token: "token-b" } } });
    const sent = recordRequests();

    const err = await send(A, "/api/keys", {}, "session", "env").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotSignedIn);
    expect((err as Error).message).toBe(
      `Not logged in to ${A}. Sign in: skrun login (SKRUN_REGISTRY_URL names this server)`,
    );
    expect(sent).toEqual([]);
  });

  it.each([
    [
      "an older CLI's file",
      { token: "older-token", registry_url: A },
      "Signed in with an older CLI — sign in again: skrun login (SKRUN_REGISTRY_URL names this server)",
    ],
    [
      "a file that cannot be read",
      "{ not json",
      "The CLI's sign-in file cannot be read — sign in again: skrun login (SKRUN_REGISTRY_URL names this server)",
    ],
  ])("%s, the server named by SKRUN_REGISTRY_URL: nothing is sent, and the sign-in it advises names no address, which would make the address typed the current one", async (_what, content, message) => {
    writeSignInFile(useThrowawayProfile(), content);
    const sent = recordRequests();

    const err = await send(A, "/api/keys", {}, "session", "env").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotSignedIn);
    expect((err as Error).message).toBe(message);
    expect(sent).toEqual([]);
  });

  it("the fetch in place when send is called is the one used, never one taken when the module loaded", async () => {
    useThrowawayProfile();
    const first = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", first);
    await send(A, "/x", {}, "none");
    const second = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", second);
    await send(A, "/y", {}, "none");

    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1]);
  });

  it("a connection tried on several addresses and refused on one: the code of that refusal is named", async () => {
    useThrowawayProfile();
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4000"), {
      code: "ECONNREFUSED",
    });
    const attempts = new AggregateError([new Error("connect failed"), refused], "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: attempts });
      }),
    );

    const err = await send(A, "/x", {}, "none").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Unreachable);
    expect((err as Error).message).toBe(`Could not reach ${A} (ECONNREFUSED).`);
  });

  it("an answer that is not a redirect is returned as it is, a refusal included", async () => {
    useThrowawayProfile();
    recordRequests(() => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 }));

    const res = await send(A, "/x", {}, "none");

    expect(res.status).toBe(404);
  });

  it.each([
    [
      "another host",
      "https://a.example",
      "https://b.example/x",
      undefined,
      "The server at https://a.example answered with a redirect to https://b.example, which the CLI does not follow.",
    ],
    [
      "the same host, another scheme",
      "http://a.example",
      "https://a.example/x",
      undefined,
      "The server at http://a.example answered with a redirect to https://a.example, which the CLI does not follow. To use that server: skrun login --registry https://a.example",
    ],
    [
      "the same host, another port",
      "https://a.example",
      "https://a.example:8443/x",
      "option",
      "The server at https://a.example answered with a redirect to https://a.example:8443, which the CLI does not follow. To use that server: skrun login --registry https://a.example:8443",
    ],
    [
      "the same host, the address from SKRUN_REGISTRY_URL",
      "http://a.example",
      "https://a.example/x",
      "env",
      "The server at http://a.example answered with a redirect to https://a.example, which the CLI does not follow. To use that server: set SKRUN_REGISTRY_URL to https://a.example",
    ],
    [
      "another host, the address from SKRUN_REGISTRY_URL",
      "https://a.example",
      "https://b.example/x",
      "env",
      "The server at https://a.example answered with a redirect to https://b.example, which the CLI does not follow.",
    ],
  ] as Array<
    [string, string, string, "option" | "env" | undefined, string]
  >)("a redirect to %s: the message advises a sign-in there only on the same host, in the form the address came in", async (_what, address, location, source, message) => {
    useThrowawayProfile();
    recordRequests(() => new Response(null, { status: 301, headers: { Location: location } }));

    const err = await send(address, "/x", {}, "none", source).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedirectRefused);
    expect((err as Error).message).toBe(message);
  });

  it("a redirect met by a typed token's check, the address from SKRUN_REGISTRY_URL: the same advice", async () => {
    useThrowawayProfile();
    recordRequests(
      () => new Response(null, { status: 308, headers: { Location: "https://a.example/api/me" } }),
    );

    const err = await checkToken("http://a.example", "token-typed", "env").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedirectRefused);
    expect((err as Error).message).toBe(
      "The server at http://a.example answered with a redirect to https://a.example, which the CLI does not follow. To use that server: set SKRUN_REGISTRY_URL to https://a.example",
    );
  });

  it("a browser's opaque redirect is refused, its target unread", async () => {
    useThrowawayProfile();
    const opaque = { type: "opaqueredirect", status: 0, headers: new Headers(), body: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => opaque as unknown as Response),
    );

    const err = await send(A, "/x", {}, "none").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedirectRefused);
    expect((err as Error).message).toBe(
      `The server at ${A} answered with a redirect (HTTP 0), which the CLI does not follow.`,
    );
  });
});

describe("a redirect is never followed — two real servers", () => {
  let servers: Server[] = [];

  /** A server on 127.0.0.1, on a free port; its address. */
  async function listen(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    servers = [];
  });

  /** A target server that records every request it receives, and the one that redirects to it. */
  async function redirectingPair(
    status: number,
    location: (target: string) => string | undefined,
  ): Promise<{ a: string; b: string; atA: IncomingHttpHeaders[]; atB: string[] }> {
    const atB: string[] = [];
    const b = await listen((req, res) => {
      atB.push(`${req.method} ${req.url}`);
      res.end("b");
    });
    const atA: IncomingHttpHeaders[] = [];
    const target = location(b);
    const a = await listen((req, res) => {
      atA.push(req.headers);
      res.writeHead(status, target === undefined ? {} : { Location: target });
      res.end();
    });
    return { a, b, atA, atB };
  }

  const STATUSES = [301, 302, 303, 307, 308];

  it.each(
    STATUSES,
  )("HTTP %i to a request that carries a token, a model key and a body: the target receives nothing, and is named", async (status) => {
    const profile = useThrowawayProfile();
    const { a, b, atA, atB } = await redirectingPair(status, (target) => `${target}/run`);
    writeSession(profile, { address: a, token: "token-a" });

    const err = await send(
      a,
      "/api/agents/dev/agent/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-LLM-API-Key": '{"google":"model-key"}' },
        body: '{"input":{}}',
      },
      "session",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedirectRefused);
    expect((err as Error).message).toBe(
      `The server at ${a} answered with a redirect to ${b}, which the CLI does not follow. To use that server: skrun login --registry ${b}`,
    );
    expect(atB).toEqual([]);
    // The request that met the redirect did carry them: the target is spared by the sender.
    expect([atA[0]?.authorization, atA[0]?.["x-llm-api-key"]]).toEqual([
      "Bearer token-a",
      '{"google":"model-key"}',
    ]);
  });

  it.each(
    STATUSES,
  )("HTTP %i to a request without a token, as the browser sign-in sends: the target receives nothing", async (status) => {
    useThrowawayProfile();
    const { a, b, atA, atB } = await redirectingPair(status, (target) => `${target}/token`);

    const err = await send(
      a,
      "/auth/device/token",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      "none",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedirectRefused);
    expect((err as RedirectRefused).target).toBe(b);
    expect(atB).toEqual([]);
    expect(atA[0]?.authorization).toBeUndefined();
  });

  it("a relative Location names the server itself", async () => {
    useThrowawayProfile();
    const { a, atB } = await redirectingPair(307, () => "/elsewhere");

    const err = await send(a, "/x", {}, "none").catch((e: unknown) => e);

    expect((err as RedirectRefused).target).toBe(a);
    expect(atB).toEqual([]);
  });

  it("a redirect without a Location says it cannot name a target", async () => {
    useThrowawayProfile();
    const { a } = await redirectingPair(302, () => undefined);

    const err = await send(a, "/x", {}, "none").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedirectRefused);
    expect((err as Error).message).toBe(
      `The server at ${a} answered with a redirect (HTTP 302), which the CLI does not follow.`,
    );
  });

  it("a redirect to a target that is neither http nor https says it cannot name a target, and never prints it", async () => {
    useThrowawayProfile();
    const { a } = await redirectingPair(302, () => "ftp://elsewhere.example/x");

    const err = await send(a, "/x", {}, "none").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RedirectRefused);
    expect((err as Error).message).toBe(
      `The server at ${a} answered with a redirect (HTTP 302), which the CLI does not follow.`,
    );
    expect((err as RedirectRefused).target).toBeUndefined();
  });

  it("a server that cannot be reached is named, with the cause", async () => {
    useThrowawayProfile();
    const closed = await listen(() => {});
    const server = servers.pop() as Server;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const err = await send(closed, "/x", {}, "none").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Unreachable);
    expect((err as Error).message).toBe(`Could not reach ${closed} (ECONNREFUSED).`);
  }, 15_000);
});

describe("a request path that does not start with / is refused before anything is sent", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const REFUSED = 'A request path must start with "/" — nothing was sent.';

  it("a session for http://127.0.0.1, and the path :<port of B>/api/me: B, on that port, receives nothing", async () => {
    const atB: string[] = [];
    const server = createServer((req, res) => {
      atB.push(`${req.method} ${req.url} ${req.headers.authorization ?? "no token"}`);
      res.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    writeSession(useThrowawayProfile(), { address: "http://127.0.0.1", token: "token-root" });

    const err = await send(
      "http://127.0.0.1",
      `:${port}/api/me`,
      { method: "GET" },
      "session",
    ).catch((e: unknown) => e);

    expect(atB).toEqual([]);
    expect((err as Error | undefined)?.message).toBe(REFUSED);
  });

  it("an address with no port, and the path .elsewhere.example/x: nothing is sent at all", async () => {
    writeSession(useThrowawayProfile(), { address: "https://api.example", token: "token-api" });
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        sent.push(String(input));
        return Response.json({});
      }),
    );

    const errors = [
      await send("https://api.example", ".elsewhere.example/x", {}, "session").catch(
        (e: unknown) => e,
      ),
      await send("https://api.example", ".elsewhere.example/x", {}, "none").catch(
        (e: unknown) => e,
      ),
    ];

    expect(sent).toEqual([]);
    expect(errors.map((err) => (err as Error | undefined)?.message)).toEqual([REFUSED, REFUSED]);
  });
});

describe("a request path that climbs out of the address's own path is refused before anything is sent", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("a session for http://127.0.0.1:<port>/a: /../b/api/me, /%2e%2e/b/api/me and /../ab/api/me reach nothing; /api/me goes to /a/api/me, with the token", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? "no token"}`);
      res.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a`;
    writeSession(useThrowawayProfile(), { address, token: "token-a" });

    const refused = [
      await send(address, "/../b/api/me", { method: "GET" }, "session").catch((e: unknown) => e),
      await send(address, "/%2e%2e/b/api/me", { method: "GET" }, "session").catch(
        (e: unknown) => e,
      ),
      await send(address, "/../ab/api/me", { method: "GET" }, "session").catch((e: unknown) => e),
      await send(address, "/../b/api/me", { method: "GET" }, "none").catch((e: unknown) => e),
    ];

    expect(seen).toEqual([]);
    expect(refused.map((err) => (err as Error | undefined)?.message)).toEqual(
      Array(4).fill(`A request would leave ${address} — nothing was sent.`),
    );

    const res = await send(address, "/api/me", { method: "GET" }, "session");

    expect(res.status).toBe(200);
    expect(seen).toEqual(["GET /a/api/me Bearer token-a"]);
  });
});

describe("checking a token the user typed", () => {
  const A = "https://a.example";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answer(response: Response): Array<{ url: string; init: RequestInit }> {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(input), init: init ?? {} });
        return response;
      }),
    );
    return sent;
  }

  it("asks the server with that token, at that address — never the token saved for it", async () => {
    const profile = useThrowawayProfile();
    writeSession(profile, { address: A, token: "token-saved" });
    const sent = answer(Response.json({ namespace: "alice" }));

    const check = await checkToken(A, "token-typed");

    expect(check).toEqual({ accepted: true, namespace: "alice" });
    expect(sent.map((s) => [s.url, s.init.method, s.init.headers])).toEqual([
      [`${A}/api/me`, "GET", { Authorization: "Bearer token-typed" }],
    ]);
  });

  it("a token the server refuses is reported with the status", async () => {
    useThrowawayProfile();
    answer(Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }));

    expect(await checkToken(A, "token-typed")).toEqual({ accepted: false, status: 401 });
  });
});
