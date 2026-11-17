import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryDb } from "./db/memory.js";
import { createApp } from "./index.js";
import {
  loopsOnLogin,
  maskCredentials,
  OperatorSiteError,
  parseAbsoluteUrl,
  parseLoginReturnPath,
  parseOperatorLink,
} from "./operator-site.js";
import { withEnv } from "./routes/oauth-flow.shared.js";
import { MemoryStorage } from "./storage/memory.js";

const TAB = "\t";
const LF = "\n";
const BACKSLASH = "\\";

/** The refusal `fn` throws; fails the case when it accepts, or throws anything else. */
function refusal(fn: () => unknown): OperatorSiteError {
  try {
    fn();
  } catch (err) {
    if (err instanceof OperatorSiteError) return err;
    throw err;
  }
  throw new Error("the value was accepted; a refusal was expected");
}

/**
 * A refusal says three things: the variable, the form it expects, and the value
 * it received — credentials masked.
 */
function expectRefused(fn: () => unknown, variable: string, value: string): void {
  const err = refusal(fn);
  expect(err.variable).toBe(variable);
  expect(err.message.startsWith(`${variable} must be `)).toBe(true);
  expect(err.message.endsWith(` — received ${JSON.stringify(maskCredentials(value))}`)).toBe(true);
  const shape = err.message.slice(`${variable} must be `.length, err.message.lastIndexOf(" — "));
  expect(shape.length).toBeGreaterThan(20);
}

describe("the path a finished sign-in returns to", () => {
  const V = "SKRUN_LOGIN_RETURN_PATH";

  it.each([
    { value: "signin", why: "no leading slash" },
    { value: "//evil.example", why: "a second slash: another host" },
    { value: `/${BACKSLASH}evil.example`, why: "a backslash read as a slash" },
    { value: "/signin?x=1", why: "a query" },
    { value: "/s#f", why: "a fragment" },
    { value: "/a/../b", why: "a dot-dot segment" },
    { value: "/%2e%2e/x", why: "an encoded dot-dot segment" },
    { value: "/a b", why: "a space" },
    { value: "/ö", why: "a character left unencoded" },
    { value: `/a${TAB}b`, why: "a tab" },
    { value: `/a${LF}b`, why: "a line break" },
  ])("refuses $value ($why)", ({ value }) => {
    expectRefused(() => parseLoginReturnPath(V, value), V, value);
  });

  it.each(["/", "/signin", "/signin/", "/%2F%2Fevil"])("accepts %s, as it is", (value) => {
    expect(parseLoginReturnPath(V, value)).toBe(value);
  });
});

describe("the operator's sign-in page", () => {
  const V = "SKRUN_LOGIN_PAGE_URL";

  it.each([
    { value: "/signin", why: "a path, not an absolute address" },
    { value: "javascript:alert(1)", why: "another scheme" },
    { value: "ftp://x", why: "another scheme" },
    { value: "https:evil.example", why: "no slashes after the scheme" },
    { value: "https:/evil.example", why: "one slash after the scheme" },
    { value: `https://x/a${TAB}b`, why: "a tab" },
    { value: `https://x/a${LF}b`, why: "a line break" },
    { value: "https://x/a b", why: "a space" },
    { value: "https://u:p@x/signin", why: "credentials" },
    { value: "https://@x/", why: "an @ before the host" },
    { value: "https://x:99999/", why: "a port out of range" },
  ])("refuses $value ($why)", ({ value }) => {
    expectRefused(() => parseAbsoluteUrl(V, value), V, value);
  });

  it.each([
    { value: "https://example.com/signin", served: "https://example.com/signin" },
    { value: "HTTPS://x/", served: "https://x/" },
    { value: "https://exämple.com/", served: "https://xn--exmple-cua.com/" },
  ])("accepts $value, served as $served", ({ value, served }) => {
    expect(parseAbsoluteUrl(V, value)).toBe(served);
  });
});

describe("the terms, privacy and docs addresses", () => {
  const VARIABLES = ["SKRUN_TERMS_URL", "SKRUN_PRIVACY_URL", "SKRUN_DOCS_URL"] as const;

  const refused = [
    { value: "javascript:alert(1)", why: "another scheme" },
    { value: "data:text/html,hi", why: "another scheme" },
    { value: "mailto:legal@example.com", why: "another scheme" },
    { value: "//evil.example/t", why: "a second slash: another site" },
    { value: `/${BACKSLASH}evil.example/t`, why: "a backslash, read as a slash" },
    { value: `/${TAB}/evil.example/t`, why: "a tab dropped, then a slash" },
    { value: `/${LF}/evil.example`, why: "a line break dropped, then a slash" },
    { value: "https://u:p@x/t", why: "credentials" },
    { value: "https:evil.example", why: "no slashes after the scheme" },
    { value: `https://x/a${TAB}b`, why: "a tab" },
    { value: "/terms?a b", why: "a space in the query" },
  ];
  const accepted = [
    { value: "https://x/t", served: "https://x/t" },
    { value: "HTTPS://X/T", served: "https://x/T" },
    { value: "/terms", served: "/terms" },
    { value: "/%2F%2Fevil", served: "/%2F%2Fevil" },
    { value: "/terms?lang=en#x", served: "/terms?lang=en#x" },
  ];

  for (const variable of VARIABLES) {
    describe(variable, () => {
      it.each(refused)("refuses $value ($why)", ({ value }) => {
        expectRefused(() => parseOperatorLink(variable, value), variable, value);
      });

      it.each(accepted)("accepts $value, served as $served", ({ value, served }) => {
        expect(parseOperatorLink(variable, value)).toBe(served);
      });
    });
  }
});

describe("credentials in a refused value", () => {
  it.each([
    { read: parseAbsoluteUrl, variable: "SKRUN_LOGIN_PAGE_URL" },
    { read: parseOperatorLink, variable: "SKRUN_TERMS_URL" },
  ])("never reach the message of $variable: they are masked", ({ read, variable }) => {
    const err = refusal(() => read(variable, "https://user:secret@x/"));

    expect(err.message).not.toContain("secret");
    expect(err.message).toContain("***@");
  });

  it.each([
    { value: "https://user:secret@x/", masked: "https://***@x/" },
    { value: "HTTPS://user:secret@x/p", masked: "HTTPS://***@x/p" },
    {
      value: `https:${BACKSLASH}${BACKSLASH}user:secret@x/`,
      masked: `https:${BACKSLASH}${BACKSLASH}***@x/`,
    },
    { value: "https:user:secret@x/", masked: "https:***@x/" },
    { value: "https://user:se/cr?et@x/", masked: "https://***@x/" },
    { value: "/terms", masked: "/terms" },
  ])("$value is shown as $masked", ({ value, masked }) => {
    expect(maskCredentials(value)).toBe(masked);
  });
});

// The server a page is on is its host and its port, whatever its scheme: a front
// that sends http to https serves the same pages on both, and a host written with
// a final dot is the same host. The in-process app below answers a path whatever
// the host, port or scheme of the request, so those are judged here.
describe("a sign-in page that would loop back through /login", () => {
  const CANONICAL = "https://api.example.com";

  it.each([
    "https://api.example.com/login",
    "https://api.example.com/login?x=1",
    "https://api.example.com/dashboard",
    "https://api.example.com/dashboard/agents",
    "https://api.example.com/playground",
    "https://api.example.com/playground/x",
    "https://api.example.com:443/login",
    "https://API.EXAMPLE.COM/login",
    "http://api.example.com/login",
    "https://api.example.com./login",
    "HTTP://API.EXAMPLE.COM:80/login",
  ])("is %s on the canonical host", (page) => {
    expect(loopsOnLogin(page, CANONICAL)).toBe(true);
  });

  it.each([
    "https://example.com/login",
    "https://api.example.com/signin",
    "https://api.example.com/dashboards",
    "https://api.example.com:8443/login",
    // The default port of the other scheme is another port: another server.
    "http://api.example.com:443/login",
    "https://api.example.com:80/login",
  ])("is not %s", (page) => {
    expect(loopsOnLogin(page, CANONICAL)).toBe(false);
  });

  it("is not guarded without a canonical origin: the only other source would be the caller", () => {
    expect(loopsOnLogin("https://api.example.com/login", undefined)).toBe(false);
  });

  // The check is given an address the parser has already read. One it cannot
  // read is the caller's mistake, and answering "no loop" would open the guard
  // without a word: it throws, and a start that reaches it is refused.
  it("throws on an address it cannot read, rather than call it no loop", () => {
    expect(() => loopsOnLogin("not an address", CANONICAL)).toThrow(TypeError);
  });
});

// A path is judged by the page the server serves at it, and the server decodes a
// path before it routes it: `/%6Cogin` is its sign-in page. Each row records what
// the server serves at that path (measured on it, the dashboard served), and the
// case checks the server still serves it, then that the page is called a loop
// exactly when it is one that sends a browser back to /login.
describe("a sign-in page judged by what the server serves at its path", () => {
  const CANONICAL = "https://api.example.com";
  const LOOPING = new Set(["the sign-in page", "the dashboard", "the playground's forward"]);
  let app: ReturnType<typeof createApp>;
  let restoreEnv: () => void;

  beforeAll(() => {
    restoreEnv = withEnv(["SKRUN_DASHBOARD", "SKRUN_DASHBOARD_DIR"]);
    process.env.SKRUN_DASHBOARD = "on";
    process.env.SKRUN_DASHBOARD_DIR = join(
      dirname(fileURLToPath(import.meta.url)),
      "../tests/fixtures/web-dist",
    );
    app = createApp(new MemoryStorage(), new MemoryDb());
  });

  afterAll(() => restoreEnv());

  async function served(path: string): Promise<string> {
    const res = await app.request(`${CANONICAL}${path}`, { redirect: "manual" });
    const body = await res.text();
    if (res.status === 302 && res.headers.get("Location") === "/dashboard/agents") {
      return "the playground's forward";
    }
    if (res.status === 200 && body.includes("<title>Sign in — Skrun</title>")) {
      return "the sign-in page";
    }
    if (res.status === 200 && body.includes("<!--fixture-spa-->")) return "the dashboard";
    return `a ${res.status}`;
  }

  it.each([
    { path: "/login", serves: "the sign-in page" },
    { path: "/%6Cogin", serves: "the sign-in page" },
    { path: "/%6C%6F%67%69%6E", serves: "the sign-in page" },
    { path: "/%6Cogin?x=1", serves: "the sign-in page" },
    { path: "/./login", serves: "the sign-in page" },
    { path: "/%2e/login", serves: "the sign-in page" },
    { path: "/LOGIN", serves: "a 404" },
    { path: "/login/", serves: "a 404" },
    { path: "/login;x", serves: "a 404" },
    { path: "/%2Flogin", serves: "a 404" },
    { path: "/%256Cogin", serves: "a 404" },
    { path: "/%6Cogin%E0", serves: "a 404" },
    { path: "/%E0%A4%A", serves: "a 404" },
    { path: "/dashboard", serves: "the dashboard" },
    { path: "/d%61shboard", serves: "the dashboard" },
    { path: "/dashboard/%61gents", serves: "the dashboard" },
    { path: "/d%61shboard/%E0", serves: "the dashboard" },
    { path: "/dashboard%2Fagents", serves: "a 404" },
    { path: "/playground", serves: "the playground's forward" },
    { path: "/pl%61yground/x", serves: "the playground's forward" },
  ])("$path serves $serves, and is a loop exactly when that page is one", async ({
    path,
    serves,
  }) => {
    expect(await served(path)).toBe(serves);
    expect(loopsOnLogin(`${CANONICAL}${path}`, CANONICAL)).toBe(LOOPING.has(serves));
  });
});

describe("a value left empty or made of blanks", () => {
  it.each([
    { read: parseLoginReturnPath, variable: "SKRUN_LOGIN_RETURN_PATH" },
    { read: parseAbsoluteUrl, variable: "SKRUN_LOGIN_PAGE_URL" },
    { read: parseOperatorLink, variable: "SKRUN_TERMS_URL" },
    { read: parseOperatorLink, variable: "SKRUN_PRIVACY_URL" },
    { read: parseOperatorLink, variable: "SKRUN_DOCS_URL" },
  ])("is $variable not set", ({ read, variable }) => {
    expect(read(variable, undefined)).toBeUndefined();
    expect(read(variable, "")).toBeUndefined();
    expect(read(variable, "   ")).toBeUndefined();
    expect(read(variable, ` ${TAB}${LF} `)).toBeUndefined();
  });
});

// The module is loaded straight from its source by a tool that runs with no
// build step: an import of anything, a package of this workspace above all,
// would fail there.
it("the module imports nothing", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "operator-site.ts"),
    "utf8",
  );
  const importing = source
    .split("\n")
    .filter(
      (line) =>
        /^\s*import\b/.test(line) ||
        /^\s*export\b.*\bfrom\s*["']/.test(line) ||
        /\b(?:import|require)\s*\(/.test(line),
    );

  expect(importing).toEqual([]);
});
