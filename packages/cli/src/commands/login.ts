import { execFile } from "node:child_process";
import type { Command } from "commander";
import { getRegistryUrl, saveToken } from "../utils/auth.js";
import * as format from "../utils/format.js";
import { generatePkce } from "../utils/pkce.js";
import { askText } from "../utils/prompts.js";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResponse {
  token: string;
  username?: string;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Best-effort browser open (non-blocking). A headless user opens the URL manually.
 *
 * Exported for tests: this was the only shell-string `exec` in the tree, and
 * the fix is about how the URL reaches the opener — a property
 * only assertable at the argv level, from outside.
 */
export function openBrowser(url: string): void {
  // The URL arrives in the registry's response, so it is untrusted input. Hand it
  // to the OS opener as an ARGUMENT and never as part of a shell command line:
  // `exec` spawns a shell, and quoting the value is not a defence. On POSIX a
  // quote-free `http://x/?a=$(cmd)` survives `new URL()` normalisation and still
  // executes; on Windows `&` separates commands.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // not a URL — the CLI already printed the verification address
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;

  // Imported statically rather than lazily: `node:child_process` is a builtin so
  // the deferral bought nothing, the "non-blocking" in the doc above is about not
  // waiting for the BROWSER, and an async layer on a security-relevant path is
  // one more thing to reason about — it also put the call out of reach of a test.
  try {
    if (process.platform === "win32") {
      // NOT `cmd /c start`: libuv quotes an argv entry only when it contains a
      // space, tab or quote, so `http://x&calc` would reach cmd.exe unquoted and
      // `&` would still separate commands. rundll32 takes the URL as a plain
      // argument with no shell anywhere on the path.
      execFile("rundll32", ["url.dll,FileProtocolHandler", parsed.href]);
    } else if (process.platform === "darwin") {
      execFile("open", [parsed.href]);
    } else {
      execFile("xdg-open", [parsed.href]);
    }
  } catch {
    /* best-effort — the CLI also prints the URL */
  }
}

/**
 * Poll `POST /auth/device/token` until authorized, expired, or the deadline.
 * `authorization_pending`/`slow_down`/`429` back off (the rate-limit 429 is
 * treated like `slow_down`); a terminal error (`expired_token`/`invalid_grant`)
 * or the timeout returns null. Dependencies are injectable for testing.
 */
export async function pollForToken(opts: {
  registryUrl: string;
  deviceCode: string;
  verifier: string;
  interval: number;
  deadlineMs?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}): Promise<DeviceTokenResponse | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? realSleep;
  const nowFn = opts.nowFn ?? Date.now;
  const deadline = nowFn() + (opts.deadlineMs ?? 120_000);
  let interval = Math.max(1, opts.interval) * 1000;

  while (nowFn() < deadline) {
    let res: Response;
    try {
      res = await fetchFn(`${opts.registryUrl}/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: opts.deviceCode, code_verifier: opts.verifier }),
      });
    } catch {
      await sleepFn(interval); // transient network error — keep polling
      continue;
    }
    if (res.ok) return (await res.json()) as DeviceTokenResponse;
    if (res.status === 429) {
      interval += 5000; // rate-limited → back off, same as slow_down
      await sleepFn(interval);
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    const code = body.error?.code;
    if (code === "authorization_pending") {
      await sleepFn(interval);
      continue;
    }
    if (code === "slow_down") {
      interval += 5000;
      await sleepFn(interval);
      continue;
    }
    return null; // expired_token / invalid_grant / anything terminal
  }
  return null;
}

/**
 * Run the OAuth 2.0 Device Authorization Grant (RFC 8628) login. Requests a device
 * code, shows the user_code + URL, opens the browser, then polls for the token —
 * which arrives in the poll body, never via a URL. Falls back to a manual token
 * prompt when the registry has no OAuth (404) or is unreachable. DI for testing.
 */
export async function deviceLogin(deps: {
  registryUrl: string;
  fetchFn: typeof fetch;
  openBrowser: (url: string) => void;
  promptToken: () => Promise<string>;
  save: (token: string, username?: string) => void;
  log: (msg: string) => void;
  success: (msg: string) => void;
  fail: (msg: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  deadlineMs?: number;
}): Promise<void> {
  const pkce = generatePkce();
  let resp: Response;
  try {
    resp = await deps.fetchFn(`${deps.registryUrl}/auth/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
      }),
    });
  } catch {
    // Registry unreachable → manual token fallback.
    deps.save(await deps.promptToken());
    deps.success("Logged in. Token saved to ~/.skrun/config.json");
    return;
  }

  if (resp.status === 404) {
    // OAuth not configured (self-host) → manual token fallback.
    deps.save(await deps.promptToken());
    deps.success("Logged in. Token saved to ~/.skrun/config.json");
    return;
  }
  if (!resp.ok) {
    deps.fail(`Login failed (device/code returned ${resp.status}). Use --token for manual login.`);
    return;
  }

  const device = (await resp.json()) as DeviceCodeResponse;
  deps.log(`Your one-time code: ${device.user_code}`);
  deps.log(`Open ${device.verification_uri} and enter it (opening your browser…)`);
  deps.openBrowser(device.verification_uri_complete);

  const result = await pollForToken({
    registryUrl: deps.registryUrl,
    deviceCode: device.device_code,
    verifier: pkce.verifier,
    interval: device.interval,
    fetchFn: deps.fetchFn,
    sleepFn: deps.sleepFn,
    nowFn: deps.nowFn,
    deadlineMs: deps.deadlineMs,
  });
  if (!result) {
    deps.fail("Login timed out or was not completed. Run `skrun login` again.");
    return;
  }
  deps.save(result.token, result.username);
  deps.success("Logged in via GitHub OAuth. Token saved to ~/.skrun/config.json");
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Authenticate with the Skrun registry")
    .option("--token <token>", "API token or key (non-interactive, e.g. sk_live_...)")
    .action(async (opts) => {
      if (opts.token) {
        // Direct token/API key mode — store and exit.
        saveToken(opts.token);
        format.success("Logged in. Token saved to ~/.skrun/config.json");
        return;
      }

      await deviceLogin({
        registryUrl: getRegistryUrl(),
        fetchFn: fetch,
        openBrowser,
        promptToken: () => askText("Enter your API token:", "dev-token"),
        save: saveToken,
        log: format.info,
        success: format.success,
        fail: format.error,
      });
    });
}
