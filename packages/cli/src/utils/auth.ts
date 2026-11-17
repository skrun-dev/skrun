import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * The CLI's directory and its sign-in file, computed at each call rather than
 * when the module loads: a test that points HOME and USERPROFILE (what
 * `homedir()` reads on Windows) to a throwaway profile is seen.
 */
function configDir(): string {
  return join(homedir(), ".skrun");
}

function configFile(): string {
  return join(configDir(), "config.json");
}

/**
 * A server address that is not one the CLI accepts. The message names where the
 * value came from (an option, a variable) but never repeats the value: a
 * mistyped address can carry a user name or a password.
 */
export class InvalidRegistryUrl extends Error {
  readonly source: string;

  constructor(source: string) {
    super(
      `${source} must be an absolute http:// or https:// address, with no user name, password, query or fragment — for example https://skrun.example.com`,
    );
    this.name = "InvalidRegistryUrl";
    this.source = source;
  }
}

/**
 * The one form of a server address the CLI stores, prints and compares.
 *
 * Accepted: an absolute `http://` or `https://` URL with no user name or
 * password, and no query or fragment — the CLI appends `/api/…` to it. The
 * raw value is checked for `?` and `#` before parsing, because the parsed URL
 * no longer shows an empty query or fragment (`https://x/?` has an empty
 * `search`). Returned: scheme and host in lower case, default port dropped,
 * trailing slashes dropped, path kept. A host's trailing dot is kept, so
 * `https://x.` and `https://x` stay two addresses: a token never follows one
 * to the other.
 *
 * `source` names where the value came from, for the message of the error it
 * throws (`--registry`, `SKRUN_REGISTRY_URL`, …).
 */
export function normalizeRegistryUrl(raw: string, source: string): string {
  if (raw.includes("?") || raw.includes("#")) throw new InvalidRegistryUrl(source);
  const url = URL.parse(raw);
  if (url === null) throw new InvalidRegistryUrl(source);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new InvalidRegistryUrl(source);
  if (url.username !== "" || url.password !== "") throw new InvalidRegistryUrl(source);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * Whether an address designates this machine: the host `localhost`, an IPv4
 * address in `127.0.0.0/8`, or `[::1]` — read on the parsed host, so `127.1`
 * counts as `127.0.0.1`. Only such an address is offered the local development
 * token by default.
 */
export function isLoopback(address: string): boolean {
  const host = URL.parse(address)?.hostname;
  if (host === undefined) return false;
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** The server the CLI talks to when nothing names another one. */
export const DEFAULT_REGISTRY_URL = "http://localhost:4000";

/** Whether a stored value is an address the CLI accepts (any form of it). */
function isAddress(value: string): boolean {
  try {
    normalizeRegistryUrl(value, "the sign-in file");
    return true;
  } catch (err) {
    if (err instanceof InvalidRegistryUrl) return false;
    throw err;
  }
}

const StoredAddress = z.string().refine(isAddress);

const SessionSchema = z.object({
  token: z.string().min(1),
  username: z.string().optional(),
});

/**
 * The sign-in file: one session per server address, and the current server —
 * the one a command goes to when neither an option nor `SKRUN_REGISTRY_URL`
 * names another. The version number tells this form from the ones older CLIs
 * wrote, even when they carry the same fields.
 */
const SessionFileSchema = z.object({
  version: z.literal(2),
  current: StoredAddress.optional(),
  sessions: z.record(StoredAddress, SessionSchema),
});

export type Session = z.infer<typeof SessionSchema>;
export type SessionFile = z.infer<typeof SessionFileSchema>;

/**
 * What the sign-in file holds: its sessions; a file written by an older CLI
 * (any object without `"version": 2`); or a file that cannot be read (not JSON,
 * not an object, or a `"version": 2` object of another shape). The last two
 * carry nothing: no token of theirs is ever sent anywhere.
 */
export type SessionFileRead =
  | { readonly kind: "sessions"; readonly file: SessionFile }
  | { readonly kind: "older" }
  | { readonly kind: "unreadable" };

const UNREADABLE: SessionFileRead = { kind: "unreadable" };
const OLDER: SessionFileRead = { kind: "older" };

/** Read the text of a sign-in file. Pure: the caller reads the file. */
export function parseSessionFile(text: string): SessionFileRead {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return UNREADABLE;
    throw err;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return UNREADABLE;
  if ((data as { version?: unknown }).version !== 2) return OLDER;
  const parsed = SessionFileSchema.safeParse(data);
  return parsed.success ? { kind: "sessions", file: parsed.data } : UNREADABLE;
}

/** The text of a sign-in file, in the form `parseSessionFile` reads back. Pure. */
export function serializeSessionFile(file: SessionFile): string {
  const ordered = { version: file.version, current: file.current, sessions: file.sessions };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * The sign-in file as it is now on disk; no file reads as no session at all. A
 * file the system does not let the CLI read throws `SignInFileNotRead`.
 */
function readSessionFile(): SessionFileRead {
  const path = configFile();
  if (!existsSync(path)) return { kind: "sessions", file: { version: 2, sessions: {} } };
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    throw new SignInFileNotRead(errorCode(err) ?? "unknown cause", { cause: err });
  }
  return parseSessionFile(text);
}

/**
 * The sign-in file is there, and the system does not let the CLI read it:
 * another program holds it (Windows refuses a file opened without sharing),
 * or its permissions refuse it. Nothing in it is used, and nothing is written
 * over it. The message names the system error's code, never the file's path —
 * the user's profile has no place on an error line.
 */
export class SignInFileNotRead extends Error {
  /** The system error code (`EBUSY`, …), or a word when there is none. */
  readonly reason: string;

  constructor(reason: string, options?: { cause?: unknown }) {
    super(
      `Could not read the CLI's sign-in file (${reason}): it is in use, or cannot be read. It is left as it was — try again.`,
      options,
    );
    this.name = "SignInFileNotRead";
    this.reason = reason;
  }
}

/**
 * The sign-in file could not be written: it is left as it was. The temporary
 * file written for it is removed when it can be; one that cannot be — another
 * program holds it — stays beside it, protected as the sign-in file is. The
 * message names the error's code — the write's or the rename's, never the
 * removal's — and never the file's path: the user's profile has no place on an
 * error line.
 */
export class SignInFileNotWritten extends Error {
  /** The system error code (`EPERM`, …), or a word when there is none. */
  readonly reason: string;

  constructor(reason: string, options?: { cause?: unknown }) {
    super(
      `Could not write the CLI's sign-in file (${reason}): it is in use, or cannot be written. It is left as it was — try again.`,
      options,
    );
    this.name = "SignInFileNotWritten";
    this.reason = reason;
  }
}

/** The codes of a rename Windows refuses while another process holds the file a moment. */
const RENAME_REFUSED_FOR_A_MOMENT = new Set(["EPERM", "EACCES", "EBUSY"]);
/** How long such a rename is tried again, on Windows. */
const RENAME_RETRY_MS = 2000;

/** Wait, synchronously: the sign-in file is written by synchronous code. */
function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename the temporary file over the sign-in file. On Windows, a rename meets a
 * file that another process holds for a moment — a second sign-in at once, a
 * command reading it, an antivirus — and fails with EPERM, EACCES or EBUSY; it
 * is tried again, waiting 0, 10, 20 … then 100 ms between tries (the pattern of
 * graceful-fs), for 2 s at most: these holds last milliseconds, and the CLI
 * waits synchronously, printing nothing — graceful-fs's 60 s suit an
 * asynchronous rename that blocks nothing. Elsewhere, and on any other error,
 * the rename fails at once.
 */
function renameOver(temporary: string, file: string): void {
  const started = Date.now();
  let wait = 0;
  for (;;) {
    try {
      renameSync(temporary, file);
      return;
    } catch (err) {
      const code = errorCode(err);
      const retried =
        process.platform === "win32" &&
        code !== undefined &&
        RENAME_REFUSED_FOR_A_MOMENT.has(code) &&
        Date.now() - started < RENAME_RETRY_MS;
      if (!retried) throw err;
    }
    waitSync(wait);
    if (wait < 100) wait += 10;
  }
}

/**
 * Write the sign-in file whole, readable by its owner only, at no moment
 * readable by another user:
 *  - the directory is created `0700`; one that already exists (an older CLI
 *    created it `0755`) is narrowed to `0700` — `mkdirSync` leaves an existing
 *    directory's mode as it is;
 *  - the text goes to a temporary file of the same directory, under a unique
 *    name (the process id and random bytes), created exclusively (`wx`) with
 *    mode `0600` — a mode applies only at creation, so a fixed name left behind
 *    by a killed process would keep its own, and two sign-ins at once would
 *    write into one file;
 *  - the temporary file is renamed over the old one in one step (tried again
 *    for a moment on Windows: `renameOver`): a write cut short leaves the old
 *    file whole. If the write or the rename fails, the temporary file is
 *    removed if it can be, and `SignInFileNotWritten` goes up whatever the
 *    removal meets.
 * Two sign-ins at once: the last rename wins — the other's session can be lost
 * —, and no file is ever half written.
 * On Windows these modes have no effect; the profile's inherited permissions
 * protect the file, as before.
 */
function writeSessionFile(file: SessionFile): void {
  const dir = configDir();
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existed) chmodSync(dir, 0o700);
  const temporary = join(dir, `.config.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, serializeSessionFile(file), { mode: 0o600, flag: "wx" });
    renameOver(temporary, configFile());
  } catch (err) {
    removeIfPossible(temporary);
    throw new SignInFileNotWritten(errorCode(err) ?? "unknown cause", { cause: err });
  }
}

/** Remove a file if the system lets the CLI; never throws — the caller reports what failed before. */
function removeIfPossible(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Held by another program (Windows), or refused: the file stays.
  }
}

/** Whether two addresses are the same server, whatever form each was written in. */
function sameAddress(a: string, b: string): boolean {
  return (
    normalizeRegistryUrl(a, "the sign-in file") === normalizeRegistryUrl(b, "the sign-in file")
  );
}

/** The sessions of a file, less the one stored for `address` (if any). */
function sessionsWithout(file: SessionFile, address: string): SessionFile["sessions"] {
  return Object.fromEntries(
    Object.entries(file.sessions).filter(([key]) => !sameAddress(key, address)),
  );
}

/**
 * Save the session of a server: its token, and the namespace it signs in as
 * when known. A session already stored for that server — under any form of its
 * address — is replaced; the others stay. `makeCurrent` makes that server the
 * current one; otherwise the current server is left as it is. A file written by
 * an older CLI, or one that cannot be read, is replaced.
 */
export function saveSession(
  address: string,
  token: string,
  username: string | undefined,
  opts: { makeCurrent: boolean },
): void {
  const normalized = normalizeRegistryUrl(address, "the address");
  const stored = readSessionFile();
  const base: SessionFile = stored.kind === "sessions" ? stored.file : { version: 2, sessions: {} };
  const session: Session = username === undefined ? { token } : { token, username };
  writeSessionFile({
    version: 2,
    current: opts.makeCurrent ? normalized : base.current,
    sessions: { ...sessionsWithout(base, normalized), [normalized]: session },
  });
}

/**
 * Remove the session of a server, and clear the current server if it was that
 * one — no other session is made current in its place. Returns whether there
 * was a session to remove; with none (or a file that is not of this CLI),
 * nothing is written.
 */
export function removeSession(address: string): boolean {
  const normalized = normalizeRegistryUrl(address, "the address");
  const stored = readSessionFile();
  if (stored.kind !== "sessions") return false;
  const { file } = stored;
  if (!Object.keys(file.sessions).some((key) => sameAddress(key, normalized))) return false;
  const current =
    file.current !== undefined && sameAddress(file.current, normalized) ? undefined : file.current;
  writeSessionFile({ version: 2, current, sessions: sessionsWithout(file, normalized) });
  return true;
}

/**
 * Remove a sign-in file written by an older CLI, or one that cannot be read —
 * nothing in it is sent anywhere first. Returns whether one was removed; a
 * file of this CLI is left as it is.
 */
export function removeOlderConfig(): boolean {
  if (readSessionFile().kind === "sessions") return false;
  rmSync(configFile(), { force: true });
  return true;
}

/** Where the target address came from. */
export type TargetSource = "option" | "env" | "session" | "default";

export interface Target {
  /** The address, in the form `normalizeRegistryUrl` returns. */
  readonly address: string;
  readonly source: TargetSource;
}

/**
 * The server a command talks to: the `--registry` option of `login`, else
 * `SKRUN_REGISTRY_URL` (empty or blank counts as not set), else the current
 * server of the sign-in file, else `DEFAULT_REGISTRY_URL`.
 *
 * A token the user typed (`typedToken`) skips the current server: it goes to
 * the address the user gave, or to the default — never to the server of an
 * existing session, which may be another instance than the one that issued it.
 * The browser sign-in sends no token, so it inherits the current server.
 *
 * Throws `InvalidRegistryUrl` when the option or the variable is not an
 * address, naming which.
 */
export function resolveTarget(opts: { registry?: string; typedToken?: boolean } = {}): Target {
  if (opts.registry !== undefined) {
    return { address: normalizeRegistryUrl(opts.registry, "--registry"), source: "option" };
  }
  const fromEnv = process.env.SKRUN_REGISTRY_URL;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { address: normalizeRegistryUrl(fromEnv, "SKRUN_REGISTRY_URL"), source: "env" };
  }
  if (!opts.typedToken) {
    const stored = readSessionFile();
    if (stored.kind === "sessions" && stored.file.current !== undefined) {
      return {
        address: normalizeRegistryUrl(stored.file.current, "the sign-in file"),
        source: "session",
      };
    }
  }
  return { address: DEFAULT_REGISTRY_URL, source: "default" };
}

/** What the sign-in file holds for one server. */
type SessionLookup =
  | { readonly state: "present"; readonly session: Session }
  | { readonly state: "absent" | "older" | "unreadable" };

/**
 * The session saved for one server — found under any form of its address —
 * and none at all from a file written by an older CLI or one that cannot be
 * read. Private to this module: outside it, nothing reads a token.
 */
function lookUpSession(address: string): SessionLookup {
  const stored = readSessionFile();
  if (stored.kind !== "sessions") return { state: stored.kind };
  const key = Object.keys(stored.file.sessions).find((k) => sameAddress(k, address));
  const session = key === undefined ? undefined : stored.file.sessions[key];
  return session === undefined ? { state: "absent" } : { state: "present", session };
}

/** Whether the sign-in file holds a session for a server: never its token. */
export type SessionState = SessionLookup["state"];

/**
 * Whether the sign-in file holds a session for a server — `"present"`,
 * `"absent"`, or none to read at all: a file of an older CLI (`"older"`) or one
 * that cannot be read (`"unreadable"`). Never the token.
 */
export function sessionState(address: string): SessionState {
  return lookUpSession(normalizeRegistryUrl(address, "the address")).state;
}

/** The token the local development mode accepts, which always stands for the namespace `dev`. */
const DEV_TOKEN = "dev-token";

/**
 * The namespace a server's session stands for, known without asking it: `dev`
 * for the local development token — whatever namespace a former session left —
 * else the namespace saved with the session; undefined when neither tells.
 * Never the token.
 */
export function cachedNamespace(address: string): string | undefined {
  const found = lookUpSession(normalizeRegistryUrl(address, "the address"));
  if (found.state !== "present") return undefined;
  if (found.session.token === DEV_TOKEN) return "dev";
  return found.session.username;
}

/**
 * Save the namespace a server named for its session, with that session; the
 * current server and the other sessions are left as they are. Without a
 * session for that server, nothing is written.
 */
export function cacheNamespace(address: string, namespace: string): void {
  const normalized = normalizeRegistryUrl(address, "the address");
  const found = lookUpSession(normalized);
  if (found.state !== "present") return;
  saveSession(normalized, found.session.token, namespace, { makeCurrent: false });
}

/**
 * The command the CLI advises to sign in to a server — with a token to type
 * when `withToken`; `address` may be `<url>`, an address for the user to fill
 * in. When the address came from `SKRUN_REGISTRY_URL`, it names no address:
 * the variable already names the server, and `--registry` would make it the
 * current one of every shell, which a sign-in under the variable never does.
 */
export function signInCommand(
  address: string,
  source: TargetSource | undefined,
  opts: { withToken?: boolean } = {},
): string {
  const token = opts.withToken ? " --token <token>" : "";
  return source === "env"
    ? `skrun login${token} (SKRUN_REGISTRY_URL names this server)`
    : `skrun login --registry ${address}${token}`;
}

/**
 * A request that needs a session, to a server the sign-in file holds none for:
 * nothing is sent. The message says why, and how to sign in — `source`, where
 * the address came from, shapes that advice. A file of an older CLI, or one
 * that cannot be read, says nothing of the server its token was for: the
 * sign-in it advises takes `<url>`, or no address under `SKRUN_REGISTRY_URL`.
 */
export class NotSignedIn extends Error {
  readonly address: string;
  readonly state: "absent" | "older" | "unreadable";

  constructor(address: string, state: "absent" | "older" | "unreadable", source?: TargetSource) {
    super(
      state === "older"
        ? `Signed in with an older CLI — sign in again: ${signInCommand("<url>", source)}`
        : state === "unreadable"
          ? `The CLI's sign-in file cannot be read — sign in again: ${signInCommand("<url>", source)}`
          : `Not logged in to ${address}. Sign in: ${signInCommand(address, source)}`,
    );
    this.name = "NotSignedIn";
    this.address = address;
    this.state = state;
  }
}

/** Whether two addresses are on the same host — their scheme or port may differ. */
function sameHost(a: string, b: string): boolean {
  const first = URL.parse(a)?.hostname;
  return first !== undefined && first === URL.parse(b)?.hostname;
}

/**
 * A server answered with a redirect, which the CLI never follows: the target
 * receives nothing — no token, no model key, no body. The message names the
 * target's origin when it can be read. On the same host (another scheme or
 * port: an `http://` address sent on to `https://`), it says how to use that
 * server — the sign-in that names it, or, when the address came from
 * `SKRUN_REGISTRY_URL` (`source`), the value to give the variable. Towards
 * another host it advises nothing: signing in again there with a token typed
 * for this server would send that token to it.
 */
export class RedirectRefused extends Error {
  readonly address: string;
  readonly status: number;
  /** The origin of the redirect's target; undefined when it cannot be read. */
  readonly target: string | undefined;

  constructor(address: string, status: number, target: string | undefined, source?: TargetSource) {
    const use =
      target === undefined || !sameHost(address, target)
        ? ""
        : source === "env"
          ? ` To use that server: set SKRUN_REGISTRY_URL to ${target}`
          : ` To use that server: skrun login --registry ${target}`;
    super(
      target === undefined
        ? `The server at ${address} answered with a redirect (HTTP ${status}), which the CLI does not follow.`
        : `The server at ${address} answered with a redirect to ${target}, which the CLI does not follow.${use}`,
    );
    this.name = "RedirectRefused";
    this.address = address;
    this.status = status;
    this.target = target;
  }
}

/** A server that could not be reached: the address, and the cause the network gave. */
export class Unreachable extends Error {
  readonly address: string;
  /** The cause: a system error code (`ECONNREFUSED`, …) when there is one, else a message. */
  readonly reason: string;

  constructor(address: string, reason: string, options?: { cause?: unknown }) {
    super(`Could not reach ${address} (${reason}).`, options);
    this.name = "Unreachable";
    this.address = address;
    this.reason = reason;
  }

  /** The error of a request to `address` that got no answer: `err` is what the request threw. */
  static fromFailure(address: string, err: unknown): Unreachable {
    return new Unreachable(address, failureReason(err), { cause: err });
  }
}

/** The system error code an error carries, itself or — a connection tried on several addresses — in one of its errors. */
function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  if (typeof code === "string" && code !== "") return code;
  if (value instanceof AggregateError) {
    for (const inner of value.errors) {
      const innerCode = errorCode(inner);
      if (innerCode !== undefined) return innerCode;
    }
  }
  return undefined;
}

/** Why a request failed before any answer: the code of its cause, else a message. */
function failureReason(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const code = errorCode(cause) ?? errorCode(err);
  if (code !== undefined) return code;
  if (cause instanceof Error && cause.message !== "") return cause.message;
  return err instanceof Error ? err.message : String(err);
}

/** The origin a redirect points to, resolved against the request; undefined when it cannot be read. */
function redirectTarget(location: string | null, requested: string): string | undefined {
  if (location === null) return undefined;
  const target = URL.parse(location, requested);
  if (target === null || (target.protocol !== "http:" && target.protocol !== "https:")) {
    return undefined;
  }
  return target.origin;
}

/** The caller's headers, as a plain object, less any `Authorization`: only the sender sets it. */
function headersWithoutAuthorization(headers: RequestInit["headers"]): Record<string, string> {
  const entries: Iterable<readonly [string, unknown]> =
    headers === undefined
      ? []
      : headers instanceof Headers
        ? headers.entries()
        : Array.isArray(headers)
          ? (headers as Array<readonly [string, unknown]>)
          : Object.entries(headers);
  const plain: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (name.toLowerCase() !== "authorization") plain[name] = String(value);
  }
  return plain;
}

/**
 * The one place a request to a server leaves from. The `fetch` in place when it
 * is called is the one used — never one captured when the module loaded. The
 * redirect mode is always `"manual"`: a `3xx` (or a browser's opaque redirect)
 * throws `RedirectRefused`, and its target receives nothing. A request that gets
 * no answer throws `Unreachable`. Any other answer is returned as it is.
 *
 * The URL is `address` followed by `path`, so a path that does not start with
 * `/` could carry the request elsewhere — `:<port>/…` to another port,
 * `.other.example/…` to another host — with the token of `address`: it is
 * refused, a programming error, before anything is sent; and a URL whose
 * origin is not the address's is refused too, should the first check ever be
 * loosened. So is one whose path, once its `..` segments are resolved (`%2e%2e`
 * included), leaves the address's own path — `/../b/…` from an address at `/a`
 * reaches `/b/…` on the same server: a path built from a value the user typed
 * (the version `skrun verify` or `skrun pull` puts in it) could carry them.
 */
async function dispatch(
  address: string,
  path: string,
  init: RequestInit,
  token: string | undefined,
  source: TargetSource | undefined,
): Promise<Response> {
  if (!path.startsWith("/")) {
    throw new Error('A request path must start with "/" — nothing was sent.');
  }
  const url = `${address}${path}`;
  const sent = URL.parse(url);
  const own = URL.parse(address);
  // The address's own path, without its trailing slash: "" for a server at its root.
  const root = own?.pathname.replace(/\/+$/, "");
  if (
    sent === null ||
    own === null ||
    sent.origin !== own.origin ||
    (sent.pathname !== root && !sent.pathname.startsWith(`${root}/`))
  ) {
    throw new Error(`A request would leave ${address} — nothing was sent.`);
  }
  const headers = headersWithoutAuthorization(init.headers);
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await globalThis.fetch(url, { ...init, headers, redirect: "manual" });
  } catch (err) {
    throw Unreachable.fromFailure(address, err);
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status <= 399)) {
    await res.body?.cancel().catch(() => {});
    throw new RedirectRefused(
      address,
      res.status,
      redirectTarget(res.headers.get("location"), url),
      source,
    );
  }
  return res;
}

/**
 * Send a request to a server: `address` followed by `path`. Under `"session"`,
 * it carries the token saved for that server — and only that one; without a
 * session for it, nothing is sent (`NotSignedIn`). Under `"none"`, no token at
 * all. No `Authorization` the caller gives is ever sent. No redirect is
 * followed (`RedirectRefused`); no answer throws `Unreachable`. `source`, where
 * the address came from, shapes only the advice of an error's message.
 */
export async function send(
  address: string,
  path: string,
  init: RequestInit,
  auth: "session" | "none",
  source?: TargetSource,
): Promise<Response> {
  const base = normalizeRegistryUrl(address, "the address");
  if (auth === "none") return dispatch(base, path, init, undefined, source);
  const found = lookUpSession(base);
  if (found.state !== "present") throw new NotSignedIn(base, found.state, source);
  return dispatch(base, path, init, found.session.token, source);
}

/** What a server says of a token the user typed. */
export type TokenCheck =
  | { readonly accepted: true; readonly namespace: string | undefined }
  | { readonly accepted: false; readonly status: number };

/**
 * Ask a server whether it accepts a token the user typed, before it is saved:
 * `GET /api/me` with that token, at that address — the one token not taken
 * from the sign-in file that ever leaves the CLI. Accepted on a `2xx`, with the
 * namespace the server names; refused on any other status. A redirect throws
 * `RedirectRefused`, no answer `Unreachable`, as for any request; `source`,
 * where the address came from, shapes only the advice of their messages.
 */
export async function checkToken(
  address: string,
  token: string,
  source?: TargetSource,
): Promise<TokenCheck> {
  const base = normalizeRegistryUrl(address, "the address");
  const res = await dispatch(base, "/api/me", { method: "GET" }, token, source);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { accepted: false, status: res.status };
  }
  const profile = (await res.json().catch(() => ({}))) as { namespace?: unknown };
  const namespace =
    typeof profile.namespace === "string" && profile.namespace !== ""
      ? profile.namespace
      : undefined;
  return { accepted: true, namespace };
}
