import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceLogin, openBrowser, pollForToken } from "./login.js";

// SEC-002 (audit/006): intercept the child-process layer so the ARGV shape is
// assertable. `openBrowser` reaches it through a dynamic import, which vi.mock
// still intercepts.
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("pollForToken", () => {
  const base = {
    registryUrl: "http://x",
    deviceCode: "dc",
    verifier: "v",
    interval: 1,
    sleepFn: async () => {},
  };

  it("returns the token when the poll succeeds", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { token: "sk_live_x", username: "bob" }));
    const r = await pollForToken({ ...base, fetchFn: fetchFn as unknown as typeof fetch });
    expect(r).toEqual({ token: "sk_live_x", username: "bob" });
  });

  it("returns null on a terminal error (expired_token)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: { code: "expired_token" } }));
    const r = await pollForToken({ ...base, fetchFn: fetchFn as unknown as typeof fetch });
    expect(r).toBeNull();
  });

  it("keeps polling through authorization_pending / slow_down / 429, then returns the token", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: { code: "authorization_pending" } }))
      .mockResolvedValueOnce(jsonResponse(400, { error: { code: "slow_down" } }))
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, { token: "sk_live_y" }));
    const r = await pollForToken({ ...base, fetchFn: fetchFn as unknown as typeof fetch });
    expect(r?.token).toBe("sk_live_y");
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("returns null when the deadline passes (timeout)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: { code: "authorization_pending" } }));
    const nows = [0, 50, 100, 150];
    let i = 0;
    const nowFn = () => nows[i++] ?? 999_999;
    const r = await pollForToken({
      ...base,
      fetchFn: fetchFn as unknown as typeof fetch,
      nowFn,
      deadlineMs: 100,
    });
    expect(r).toBeNull();
  });
});

describe("deviceLogin", () => {
  const baseDeps = () => ({
    registryUrl: "http://x",
    sleepFn: async () => {},
    openBrowser: vi.fn(),
    promptToken: vi.fn().mockResolvedValue("manual-token"),
    save: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    fail: vi.fn(),
  });

  it("runs the device flow: prints the user_code, opens the browser, polls, saves the token", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "dc",
          user_code: "WXYZ-3456",
          verification_uri: "http://x/device",
          verification_uri_complete: "http://x/device?user_code=WXYZ-3456",
          expires_in: 600,
          interval: 1,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { token: "sk_live_z", username: "carol" }));
    const deps = { ...baseDeps(), fetchFn: fetchFn as unknown as typeof fetch };
    await deviceLogin(deps);
    expect(deps.openBrowser).toHaveBeenCalledWith("http://x/device?user_code=WXYZ-3456");
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("WXYZ-3456"));
    expect(deps.save).toHaveBeenCalledWith("sk_live_z", "carol");
    expect(deps.promptToken).not.toHaveBeenCalled();
  });

  it("falls back to the token prompt when OAuth is not configured (404)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { error: { code: "OAUTH_NOT_CONFIGURED" } }));
    const deps = { ...baseDeps(), fetchFn: fetchFn as unknown as typeof fetch };
    await deviceLogin(deps);
    expect(deps.promptToken).toHaveBeenCalled();
    expect(deps.save).toHaveBeenCalledWith("manual-token");
    // No loopback server, no second poll — the device flow short-circuited.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the token prompt when the registry is unreachable", async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error("network"));
    const deps = { ...baseDeps(), fetchFn: fetchFn as unknown as typeof fetch };
    await deviceLogin(deps);
    expect(deps.promptToken).toHaveBeenCalled();
    expect(deps.save).toHaveBeenCalledWith("manual-token");
  });

  it("fails cleanly when polling times out", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          device_code: "dc",
          user_code: "WXYZ-3456",
          verification_uri: "http://x/device",
          verification_uri_complete: "http://x/d",
          expires_in: 600,
          interval: 1,
        }),
      )
      .mockResolvedValue(jsonResponse(400, { error: { code: "authorization_pending" } }));
    const nows = [0, 50, 100, 150];
    let i = 0;
    const deps = {
      ...baseDeps(),
      fetchFn: fetchFn as unknown as typeof fetch,
      nowFn: () => nows[i++] ?? 999_999,
      deadlineMs: 100,
    };
    await deviceLogin(deps);
    expect(deps.fail).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    expect(deps.save).not.toHaveBeenCalled();
  });
});

describe("openBrowser — command injection (SEC-002, audit/006)", () => {
  /**
   * The URL comes from the registry's JSON response through a bare TypeScript
   * cast — no schema, no type guard — and `getRegistryUrl` has no TLS
   * requirement and defaults to plaintext. So a hostile or MITM'd registry
   * chooses this string. Before the fix it was interpolated into a shell
   * command line; all three payloads below were reproduced executing.
   *
   * The fix stops them at two different places, which is why they are split:
   * `new URL()` rejects the quote-bearing ones outright, and the quote-free one
   * — which parses fine, keeping `$( )` intact — is stopped only by handing the
   * value to the opener as an argv entry. That second class is the reason a URL
   * parse is NOT a substitute for argument-array execution.
   */
  const UNPARSEABLE = [
    // POSIX, closing the double quote the old code wrapped the URL in
    'http://x"; echo INJECTED; echo "',
    // Windows: `;` is an argument delimiter on cmd.exe, `&` is the separator
    'http://x" & echo INJECTED & rem "',
  ];
  const PARSES_BUT_HARMLESS_AS_ARGV = [
    // Survives `new URL()`, which encodes the space but leaves `$`, `(`, `)`
    "http://x/?a=$(echo INJECTED)",
    // Windows command separator, inside the authority
    "http://x&calc",
  ];

  const PLATFORMS = [
    { platform: "win32", bin: "rundll32" },
    { platform: "darwin", bin: "open" },
    { platform: "linux", bin: "xdg-open" },
  ] as const;

  function openOn(platform: string, url: string): void {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      openBrowser(url);
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  }

  beforeEach(() => {
    execFileMock.mockClear();
  });

  it("VT-12: a payload that parses reaches the opener as ONE argv entry, with no shell", () => {
    for (const { platform, bin } of PLATFORMS) {
      for (const payload of PARSES_BUT_HARMLESS_AS_ARGV) {
        execFileMock.mockClear();
        openOn(platform, payload);

        expect(execFileMock).toHaveBeenCalledTimes(1);
        const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
        expect(file).toBe(bin);
        // No interpreter, and no `-c` / `/c` that would turn an argument into a
        // command line. The old code passed a single string to a shell; this
        // passes a vector to an executable.
        expect(file).not.toMatch(/^(sh|bash|cmd|cmd\.exe|powershell|pwsh)$/);
        expect(args).not.toContain("-c");
        expect(args).not.toContain("/c");
        // The payload is exactly one argument — nothing was split on `;`, `&`
        // or `$( )`.
        const urlArgs = args.filter((a) => a.includes("x"));
        expect(urlArgs).toHaveLength(1);
      }
    }
  });

  it("VT-12b: the Windows branch is rundll32, NOT `cmd /c start`", () => {
    // `cmd /c start` was the first proposed fix and does not close the hole:
    // libuv quotes an argv entry only when it contains a space, tab or quote,
    // so `http://x&calc` reaches cmd.exe unquoted and `&` still separates.
    // Verified by the audit's own isolated verifier before this was written.
    openOn("win32", "http://x&calc");

    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe("rundll32");
    expect(args[0]).toBe("url.dll,FileProtocolHandler");
  });

  it("VT-12c: the quote-bearing payloads never reach a spawn at all", () => {
    // `new URL()` rejects these — the quote is illegal in the authority. Not the
    // load-bearing defence (VT-12 is), but worth pinning: it is the reason the
    // reproduced POSIX and cmd.exe payloads die before any platform branch runs.
    for (const payload of UNPARSEABLE) {
      expect(() => new URL(payload)).toThrow();
      execFileMock.mockClear();
      openOn("linux", payload);
      expect(execFileMock).not.toHaveBeenCalled();
    }
  });

  it("VT-13: a non-http(s) scheme spawns nothing", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://evil.example/x"]) {
      execFileMock.mockClear();
      openOn("linux", url);
      expect(execFileMock).not.toHaveBeenCalled();
    }
  });

  it("VT-13b: a legitimate https URL still opens", () => {
    // The whole point is that the feature keeps working.
    openOn("darwin", "https://registry.example/device?user_code=WXYZ-3456");
    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe("open");
    expect(args[0]).toBe("https://registry.example/device?user_code=WXYZ-3456");
  });
});
