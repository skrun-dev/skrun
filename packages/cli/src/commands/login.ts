import { execFile } from "node:child_process";
import type { Command } from "commander";
import {
  checkToken,
  InvalidRegistryUrl,
  isLoopback,
  RedirectRefused,
  resolveTarget,
  saveSession,
  send,
  signInCommand,
  type TargetSource,
  Unreachable,
} from "../utils/auth.js";
import { exitWith } from "../utils/exit.js";
import * as format from "../utils/format.js";
import { generatePkce } from "../utils/pkce.js";
import { askTextOrCancel, canPrompt } from "../utils/prompts.js";

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

/** How long the browser sign-in waits when the server does not say how long its code lives. */
const FALLBACK_WAIT_MS = 2 * 60_000;

/**
 * The longest the browser sign-in waits, whatever the server says: room to
 * create an account and pass a second factor on the way, never an unbounded
 * wait on a server that keeps its codes for years.
 */
const LONGEST_WAIT_MS = 15 * 60_000;

/**
 * How long to poll for a device code that lives `expiresIn` seconds — the
 * server's `expires_in` (RFC 8628 § 3.5: the client polls until the code
 * expires): that long, at most `LONGEST_WAIT_MS`. The answer is read as it
 * comes, unchecked, so anything but a finite number above zero — absent,
 * `null`, `0`, negative, a string — is a server that says nothing:
 * `FALLBACK_WAIT_MS`.
 */
function deviceCodeWaitMs(expiresIn: unknown): number {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return FALLBACK_WAIT_MS;
  }
  return Math.min(expiresIn * 1000, LONGEST_WAIT_MS);
}

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
 * Poll `POST /auth/device/token` until authorized, expired, or the deadline —
 * as long as the server keeps the device code (`expiresIn`, its `expires_in`),
 * fifteen minutes at most, two minutes when it does not say.
 * `authorization_pending`/`slow_down`/`429` back off (the rate-limit 429 is
 * treated like `slow_down`); a terminal error (`expired_token`/`invalid_grant`)
 * or the timeout returns null. A poll that gets no answer is retried; one
 * answered with a redirect throws `RedirectRefused` at once. The requests leave
 * through the CLI's single sender, which carries no token for them. The clock,
 * the wait and the deadline are injectable for testing (`deadlineMs`, when
 * given, wins over the server's lifetime).
 */
export async function pollForToken(opts: {
  registryUrl: string;
  /** Where the address came from, for the advice of a redirect's message. */
  source?: TargetSource;
  deviceCode: string;
  verifier: string;
  interval: number;
  /** Seconds the server keeps the device code, as its answer gave them (read unchecked). */
  expiresIn?: unknown;
  deadlineMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}): Promise<DeviceTokenResponse | null> {
  const sleepFn = opts.sleepFn ?? realSleep;
  const nowFn = opts.nowFn ?? Date.now;
  const deadline = nowFn() + (opts.deadlineMs ?? deviceCodeWaitMs(opts.expiresIn));
  let interval = Math.max(1, opts.interval) * 1000;

  while (nowFn() < deadline) {
    let res: Response;
    try {
      res = await send(
        opts.registryUrl,
        "/auth/device/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: opts.deviceCode, code_verifier: opts.verifier }),
        },
        "none",
        opts.source,
      );
    } catch (err) {
      // No answer is a transient network error: keep polling. A redirect is not:
      // the sign-in ends at once, naming where the server sends it.
      if (!(err instanceof Unreachable)) throw err;
      await sleepFn(interval);
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
 * A request of the sign-in that met a server it cannot use: one that gets no
 * answer, or answers with a redirect. The user is told why, naming the server
 * (and the redirect's target), and the command ends with 1, nothing saved. Any
 * other error goes up as it is.
 */
function failOnServer(address: string, err: unknown, fail: (msg: string) => void): never {
  if (err instanceof Unreachable) {
    fail(
      `Could not reach ${address} (${err.reason}). Nothing was saved. To sign in elsewhere: skrun login --registry <url>`,
    );
    exitWith(1);
  }
  if (err instanceof RedirectRefused) {
    fail(err.message);
    exitWith(1);
  }
  throw err;
}

/** What the CLI prints once signed in. */
function loggedIn(address: string, namespace: string | undefined): string {
  return namespace === undefined
    ? `Logged in to ${address}`
    : `Logged in to ${address} as ${namespace}`;
}

/**
 * Sign in with a token the user typed: the server is asked first, by `GET
 * /api/me` with that token at that address. Accepted, the token is saved with
 * the namespace the server named. Refused, unreachable or redirected: nothing
 * is saved — a session already saved for that server stays as it was — and the
 * command ends with 1, saying why. An empty or blank token is no token: refused
 * before anything is sent (the prompt's answer is checked before it gets here).
 */
async function signInWithTypedToken(
  address: string,
  token: string,
  deps: {
    source?: TargetSource;
    save: (token: string, username?: string) => void;
    success: (msg: string) => void;
    fail: (msg: string) => void;
  },
): Promise<void> {
  if (token.trim() === "") {
    deps.fail("No token was given. Nothing was sent.");
    exitWith(1);
  }
  let check: Awaited<ReturnType<typeof checkToken>>;
  try {
    check = await checkToken(address, token, deps.source);
  } catch (err) {
    failOnServer(address, err, deps.fail);
  }
  if (!check.accepted) {
    deps.fail(
      `The server at ${address} refused this token (HTTP ${check.status}). Nothing was saved.`,
    );
    exitWith(1);
  }
  deps.save(token, check.namespace);
  deps.success(loggedIn(address, check.namespace));
}

/**
 * Run the OAuth 2.0 Device Authorization Grant (RFC 8628) login. Requests a device
 * code, shows the user_code + URL, opens the browser, then polls for the token —
 * which arrives in the poll body, never via a URL, with the namespace: it is
 * saved as it comes. Every failure ends the command with 1, nothing saved: a
 * server that cannot be reached, or answers with a redirect (both named), any
 * other refusal of the device code, a sign-in that times out or that the
 * server ends. A server with no browser sign-in (404) is asked for a token
 * instead — the local development token offered by default on this machine
 * only — which the server checks before it is saved; unless its address was
 * inherited from the current session (`source` "session"): a token is never
 * typed for a server the user did not name, so that ends with 1 too, saying how
 * to give it. With no terminal to type it in (`canPrompt` false: a script, a CI
 * job), the prompt is not shown — the command ends with 1, giving the command
 * with the token; a prompt the user cancels, or answers with no token, ends
 * with 1 too. Each failure that advises a sign-in names no address when the
 * address came from `SKRUN_REGISTRY_URL` (`source` "env"). DI for testing.
 */
export async function deviceLogin(deps: {
  registryUrl: string;
  /** Where the address came from: an option, the variable, the current session, or the default. */
  source?: TargetSource;
  openBrowser: (url: string) => void;
  /** Whether a token can be typed: the standard input is a terminal. */
  canPrompt: () => boolean;
  /** The token typed; undefined when the user cancelled the prompt. */
  promptToken: (message: string, defaultToken: string | undefined) => Promise<string | undefined>;
  save: (token: string, username?: string) => void;
  log: (msg: string) => void;
  success: (msg: string) => void;
  fail: (msg: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  deadlineMs?: number;
}): Promise<void> {
  const address = deps.registryUrl;
  const withToken = signInCommand(address, deps.source, { withToken: true });
  const pkce = generatePkce();
  let resp: Response;
  try {
    resp = await send(
      address,
      "/auth/device/code",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code_challenge: pkce.challenge,
          code_challenge_method: pkce.method,
        }),
      },
      "none",
      deps.source,
    );
  } catch (err) {
    failOnServer(address, err, deps.fail);
  }

  if (resp.status === 404) {
    // No browser sign-in on this server (self-host without OAuth).
    await resp.body?.cancel().catch(() => {});
    if (deps.source === "session") {
      deps.fail(`The server at ${address} has no browser sign-in — to use a token: ${withToken}`);
      exitWith(1);
    }
    if (!deps.canPrompt()) {
      deps.fail(`No terminal to type a token for ${address} — give it: ${withToken}`);
      exitWith(1);
    }
    const token = await deps.promptToken(
      `The server at ${address} has no browser sign-in. API token for ${address}:`,
      isLoopback(address) ? "dev-token" : undefined,
    );
    if (token === undefined) {
      deps.fail("Nothing was saved.");
      exitWith(1);
    }
    // Nothing typed, or blanks: no token. (At an address of this machine, the
    // prompt answers an empty input with the dev-token it offers.) The request
    // for a device code has gone out, so the message says what was not done.
    if (token.trim() === "") {
      deps.fail("No token was given. Nothing was saved.");
      exitWith(1);
    }
    await signInWithTypedToken(address, token, deps);
    return;
  }
  if (!resp.ok) {
    deps.fail(
      `Login failed (${address}/auth/device/code returned ${resp.status}). To use a token instead: ${withToken}`,
    );
    exitWith(1);
  }

  const device = (await resp.json()) as DeviceCodeResponse;
  deps.log(`Your one-time code: ${device.user_code}`);
  deps.log(`Open ${device.verification_uri} and enter it (opening your browser…)`);
  deps.openBrowser(device.verification_uri_complete);

  let result: DeviceTokenResponse | null;
  try {
    result = await pollForToken({
      registryUrl: address,
      source: deps.source,
      deviceCode: device.device_code,
      verifier: pkce.verifier,
      interval: device.interval,
      expiresIn: device.expires_in,
      sleepFn: deps.sleepFn,
      nowFn: deps.nowFn,
      deadlineMs: deps.deadlineMs,
    });
  } catch (err) {
    failOnServer(address, err, deps.fail);
  }
  if (!result) {
    deps.fail(
      `Login to ${address} timed out or was not completed. Run: ${signInCommand(address, deps.source)}`,
    );
    exitWith(1);
  }
  deps.save(result.token, result.username);
  deps.success(loggedIn(address, result.username));
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Authenticate with the Skrun registry")
    .option(
      "--registry <url>",
      "Server to sign in to (e.g. https://skrun.example.com); later commands go there until you sign in elsewhere",
    )
    .option("--token <token>", "API token or key (non-interactive, e.g. skrun_sk_...)")
    .action(async (opts: { registry?: string; token?: string }) => {
      // The server: --registry, else SKRUN_REGISTRY_URL, else the current
      // session's (the browser sign-in only — it sends no token), else the
      // default. With --token, the current session is skipped: a typed token
      // goes to an address the user gave, or to the default — an empty one
      // too, which is then refused before anything is sent.
      let target: ReturnType<typeof resolveTarget>;
      try {
        target = resolveTarget({ registry: opts.registry, typedToken: opts.token !== undefined });
      } catch (err) {
        if (!(err instanceof InvalidRegistryUrl)) throw err;
        format.error(err.message);
        exitWith(1);
      }
      const { address } = target;
      // The server signed in to becomes the current one — unless its address
      // came from SKRUN_REGISTRY_URL alone: the variable points one shell at a
      // server, it never changes where the other shells go.
      const makeCurrent = target.source !== "env";
      const save = (token: string, username?: string): void =>
        saveSession(address, token, username, { makeCurrent });

      if (opts.token !== undefined) {
        await signInWithTypedToken(address, opts.token, {
          source: target.source,
          save,
          success: format.success,
          fail: format.error,
        });
        return;
      }

      await deviceLogin({
        registryUrl: address,
        source: target.source,
        openBrowser,
        canPrompt,
        promptToken: (message, defaultToken) => askTextOrCancel(message, defaultToken),
        save,
        log: format.info,
        success: format.success,
        fail: format.error,
      });
    });
}
