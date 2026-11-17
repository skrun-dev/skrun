/**
 * The settings of the operator's own site — the path a finished sign-in returns
 * to, the operator's own sign-in page, and the addresses of its terms, privacy
 * policy and docs — and the rules that decide whether a value is one this server
 * will serve, the canonical public origin they are judged against included.
 *
 * Each rule refuses rather than repairs: a value that is not already in the form
 * it will be served in is refused, with a message that names the variable, the
 * form it expects and the value it received, credentials masked. A value left
 * empty, or made only of blanks, is a value not set: the default applies.
 *
 * This module has no import statement, and must keep none: a tool loads it
 * straight from its source, with no build step and no package of this workspace
 * to resolve. What it needs is the language's own (`URL`, `JSON`).
 */

/** A value of one of these settings that this server refuses to serve. */
export class OperatorSiteError extends Error {
  /** The environment variable the value was read from. */
  readonly variable: string;

  constructor(variable: string, shape: string, received: string) {
    super(`${variable} must be ${shape} — received ${JSON.stringify(maskCredentials(received))}`);
    this.name = "OperatorSiteError";
    this.variable = variable;
  }
}

const RETURN_PATH_SHAPE =
  'a path on the site\'s origin — a single leading "/", already in its normalised form ' +
  '(no "." or ".." segment; a space or a non-ASCII character percent-encoded), with no query ' +
  "or fragment (e.g. /signin)";

const ABSOLUTE_URL_SHAPE =
  "an absolute address that starts with http:// or https://, with no blank, control character " +
  "or credentials (e.g. https://example.com/signin)";

const LINK_SHAPE =
  "an absolute address that starts with http:// or https://, with no blank, control character " +
  'or credentials — or a path on this site: a single leading "/", the path in its normalised ' +
  "form, then an optional query and fragment with no blank or control character " +
  "(e.g. https://example.com/terms, or /terms)";

/** Any blank (a space, a tab, a line break, a no-break space…) or control character. */
const BLANK_OR_CONTROL = /[\s\p{Cc}]/u;

/**
 * The origin a path is resolved on to read its normalised form. Any origin of an
 * http or https address gives a path the same form; this one is reserved.
 */
const PATH_ORIGIN = "https://example.invalid";

/** The pages of this server that send a browser that is not signed in back to `/login`. */
const LOOP_PAGES = ["/login", "/dashboard", "/playground"];

/** The sections of this server whose every page does the same. */
const LOOP_SECTIONS = ["/dashboard/", "/playground/"];

/** A value left empty or made only of blanks is a value not set; any other loses its edge blanks. */
function present(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

/**
 * Whether `path`, resolved on an origin, comes back unchanged — it is already its
 * own normalised form. What the address parser would change (a dot-dot segment
 * resolved, a space or a non-ASCII character encoded, a tab or a line break
 * dropped, a backslash read as a slash, a query or a fragment split off) is
 * refused here, not repaired: the value served is the value written.
 */
function isOwnNormalForm(path: string): boolean {
  try {
    return new URL(PATH_ORIGIN + path).pathname === path;
  } catch {
    return false;
  }
}

/** The address `value` names under the rules of an absolute address, or `undefined` when it breaks one. */
function absoluteUrl(value: string): URL | undefined {
  // The literal prefix, scheme and both slashes: `https:host` and `https:/host`
  // parse to the address `https://host` names, but they are not what they look
  // like to whoever reads the configuration.
  if (!/^https?:\/\//i.test(value)) return undefined;
  // No blank and no control character anywhere: the parser drops a tab or a line
  // break without a word, and a line break that reached a response header would
  // fail every request instead of refusing this start.
  if (BLANK_OR_CONTROL.test(value)) return undefined;
  // No credentials: neither `user:pass@` nor a lone `@` before the host, which
  // the parser accepts and drops. The authority ends where the parser ends it.
  const slashes = value.indexOf("//");
  const authority = slashes === -1 ? "" : (value.slice(slashes + 2).split(/[/\\?#]/)[0] ?? "");
  if (authority.includes("@")) return undefined;
  try {
    return new URL(value);
  } catch {
    // A value the parser refuses — a port out of range, a host it cannot read.
    return undefined;
  }
}

/**
 * The path a finished sign-in returns to, on the site's origin. A single leading
 * slash, in its own normalised form, with no query or fragment.
 */
export function parseLoginReturnPath(
  variable: string,
  raw: string | undefined,
): string | undefined {
  const value = present(raw);
  if (value === undefined) return undefined;
  // A single leading slash: `//host` is a path the parser leaves as it is, and
  // every link resolver reads as another host.
  if (!value.startsWith("/") || value[1] === "/") {
    throw new OperatorSiteError(variable, RETURN_PATH_SHAPE, value);
  }
  if (!isOwnNormalForm(value)) throw new OperatorSiteError(variable, RETURN_PATH_SHAPE, value);
  return value;
}

/** An absolute http or https address, served in its normalised form (`URL.href`). */
export function parseAbsoluteUrl(variable: string, raw: string | undefined): string | undefined {
  const value = present(raw);
  if (value === undefined) return undefined;
  const url = absoluteUrl(value);
  if (url === undefined) throw new OperatorSiteError(variable, ABSOLUTE_URL_SHAPE, value);
  return url.href;
}

/**
 * A link the operator's pages are reached by: an absolute address, served in its
 * normalised form — or a path on this site, served as written.
 */
export function parseOperatorLink(variable: string, raw: string | undefined): string | undefined {
  const value = present(raw);
  if (value === undefined) return undefined;
  if (!value.startsWith("/")) {
    const url = absoluteUrl(value);
    if (url === undefined) throw new OperatorSiteError(variable, LINK_SHAPE, value);
    return url.href;
  }
  // A path on this site, in two parts: the path before the first `?` or `#`, and
  // what follows it.
  const cut = value.search(/[?#]/);
  const path = cut === -1 ? value : value.slice(0, cut);
  const rest = cut === -1 ? "" : value.slice(cut);
  // The path's second character is where a link on a page turns into another
  // site: `//host` — and, once the browser has read a backslash as a slash and
  // dropped a tab or a line break, `/\host`, `/<tab>/host`, `/<line break>/host`.
  // The first is refused by its slash, the others by the path's own form.
  if (path[1] === "/") throw new OperatorSiteError(variable, LINK_SHAPE, value);
  if (!isOwnNormalForm(path)) throw new OperatorSiteError(variable, LINK_SHAPE, value);
  if (BLANK_OR_CONTROL.test(rest)) throw new OperatorSiteError(variable, LINK_SHAPE, value);
  return value;
}

/**
 * `value` with everything between its scheme and its last `@` replaced by `***`:
 * what a refusal message prints in place of credentials. The last `@`, not the
 * first one after the host: a password typed with an unencoded `/`, `?` or `#`
 * still ends at the `@` before the host.
 */
export function maskCredentials(value: string): string {
  const at = value.lastIndexOf("@");
  if (at === -1) return value;
  const scheme = /^[a-z][a-z0-9+.-]*:[/\\]*/i.exec(value)?.[0] ?? "";
  return `${scheme}***${value.slice(at)}`;
}

/** The form the canonical public origin (`SKRUN_PUBLIC_URL`) must take, as a refusal names it. */
export const PUBLIC_URL_SHAPE =
  "an absolute http(s) origin with no path, query or fragment " +
  "(e.g. https://api.example.com or https://api.example.com:8443)";

/**
 * Parse and validate the canonical public origin an operator configured
 * (`SKRUN_PUBLIC_URL`), against which the sign-in page's loop is judged.
 *
 * Throws, with a message naming the value received — credentials masked, as the
 * refusal of the operator's site settings masks them — and what was expected. It
 * runs once, at startup, from `createApp`, and a tool that checks a set of
 * settings before posting them applies the same rule: it lives in this module,
 * which imports nothing, so that tool can load it without a build.
 *
 * Accepted: an absolute `http` or `https` URL, a port if you need one, and nothing
 * else — no path (a bare `/` is tolerated because `new URL` adds it), no query, no
 * fragment. Those are refused rather than ignored: a path in a value whose whole
 * job is to be an *origin* means the operator expected something we would silently
 * drop.
 */
export function parsePublicUrl(raw: string): URL {
  const shown = maskCredentials(raw);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SKRUN_PUBLIC_URL must be ${PUBLIC_URL_SHAPE} — received "${shown}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `SKRUN_PUBLIC_URL must be ${PUBLIC_URL_SHAPE} — received "${shown}" (scheme "${url.protocol.replace(":", "")}")`,
    );
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(
      `SKRUN_PUBLIC_URL must be ${PUBLIC_URL_SHAPE} — received "${shown}" (it carries a path, query or fragment)`,
    );
  }
  return url;
}

/**
 * `path` as this server's router reads it before matching it to a route: decoded
 * by `decodeURI`, so an encoded `/`, `?`, `#` or `;` stays encoded — `/%6Cogin` is
 * `/login` there, `/%2Flogin` is not. An encoded `%` stays encoded, so nothing is
 * decoded twice; a run of escapes that does not decode (`%E0` alone is half a
 * character) stays as it is, and the rest of the path is still decoded.
 */
function routedPath(path: string): string {
  if (!path.includes("%")) return path;
  const escaped = path.replace(/%25/g, "%2525");
  try {
    return decodeURI(escaped);
  } catch {
    return escaped.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURI(run);
      } catch {
        return run;
      }
    });
  }
}

/**
 * The server an address reaches, as the loop check compares it: its host and its
 * port, never its scheme. A front that answers http with a redirect to https
 * serves the same pages under both, so `http://` on this server's host is this
 * server. The parser has already folded the host's case and dropped a port that
 * is its scheme's default, which makes the default ports of http and https one
 * and the same; a final dot (`api.example.com.`) names the same host as well.
 */
function serverOf(url: URL): string {
  return `${url.hostname.replace(/\.$/, "")}:${url.port}`;
}

/**
 * Whether the sign-in page `href` is a page of this server that sends a browser
 * that is not signed in back to `/login` — `/login` itself, the dashboard, or the
 * playground, which forwards to the dashboard. The page is on this server when
 * its host and port are the canonical origin's, whatever the scheme of either
 * (`serverOf`); the path is compared as the router reads it, decoded, since that
 * is the page the browser is served; the query and the fragment are not part of
 * the comparison.
 *
 * Without a canonical origin the loop is not guarded: the only other source for
 * this server's origin is the request's `Host`, which is the caller's.
 *
 * `href` is an address the parser has already read — its served form. One it
 * cannot read throws the parser's error rather than answer "no loop", which
 * would open the guard without a word; the start that reaches it is refused.
 */
export function loopsOnLogin(href: string, canonicalOrigin: string | undefined): boolean {
  if (canonicalOrigin === undefined) return false;
  const page = new URL(href);
  if (serverOf(page) !== serverOf(new URL(canonicalOrigin))) return false;
  const path = routedPath(page.pathname);
  return LOOP_PAGES.includes(path) || LOOP_SECTIONS.some((section) => path.startsWith(section));
}

/** What the docs links point to when the operator names no docs of their own. */
export const DEFAULT_DOCS_URL = "/docs";

/** The operator's own site, as this server serves it — read once, at start. */
export interface OperatorSite {
  /** The canonical public URL (`SKRUN_PUBLIC_URL`), as the start validated it; none when not set. */
  canonicalUrl: URL | undefined;
  /** The session cookie domain, as the start validated it; none when not set. */
  cookieDomain: string | undefined;
  /** The path a finished sign-in returns to on the site's origin: `/` when not set. */
  loginReturnPath: string;
  /** The operator's own sign-in page, in its served form; none: this server's page. */
  loginPageUrl: string | undefined;
  /** The addresses the pages and the dashboard link to, each in its served form. */
  links: {
    docs: string;
    terms: string | undefined;
    privacy: string | undefined;
  };
}

/**
 * The operator's own site, read from `env` and refused rather than repaired:
 * each setting on its own form first, in this order — the return path, the
 * sign-in page, the terms, the privacy policy, the docs —, then the two rules
 * that read a pair. `canonicalUrl` and `cookieDomain` are the values the start
 * has already validated: they are passed in, never read again here.
 *
 * Throws an `OperatorSiteError` naming the variable, the form it expects and the
 * value it received, credentials masked.
 */
export function readOperatorSite(
  env: Readonly<Record<string, string | undefined>>,
  read: { canonicalUrl: URL | undefined; cookieDomain: string | undefined },
): OperatorSite {
  const loginReturnPath = parseLoginReturnPath(
    "SKRUN_LOGIN_RETURN_PATH",
    env.SKRUN_LOGIN_RETURN_PATH,
  );
  const loginPageUrl = parseAbsoluteUrl("SKRUN_LOGIN_PAGE_URL", env.SKRUN_LOGIN_PAGE_URL);
  const terms = parseOperatorLink("SKRUN_TERMS_URL", env.SKRUN_TERMS_URL);
  const privacy = parseOperatorLink("SKRUN_PRIVACY_URL", env.SKRUN_PRIVACY_URL);
  const docs = parseOperatorLink("SKRUN_DOCS_URL", env.SKRUN_DOCS_URL);

  // The return path is a path on the site's origin, and the cookie domain is what
  // names that origin. Without it a finished sign-in goes to /dashboard on this
  // server's own host: a path set there would be ignored without a word.
  if (loginReturnPath !== undefined && read.cookieDomain === undefined) {
    throw new OperatorSiteError(
      "SKRUN_LOGIN_RETURN_PATH",
      "set together with SKRUN_SESSION_COOKIE_DOMAIN, which names the site's origin the path is " +
        "on: without a cookie domain, a finished sign-in goes to /dashboard on this server's own " +
        "host and the path would be ignored (set SKRUN_SESSION_COOKIE_DOMAIN, or unset " +
        "SKRUN_LOGIN_RETURN_PATH)",
      loginReturnPath,
    );
  }

  // /login answers with a redirect to the operator's page: a page of this server
  // that sends the browser back to /login would redirect it there again, forever.
  const canonicalOrigin = read.canonicalUrl?.origin;
  if (loginPageUrl !== undefined && loopsOnLogin(loginPageUrl, canonicalOrigin)) {
    throw new OperatorSiteError(
      "SKRUN_LOGIN_PAGE_URL",
      `a page that does not send the browser back to /login: on this server's own host and ` +
        `port (${canonicalOrigin}, from SKRUN_PUBLIC_URL — under http or https alike), /login, ` +
        "the dashboard and the playground send a browser that is not signed in to /login, which " +
        "would redirect it to this page again, without end",
      loginPageUrl,
    );
  }

  return {
    canonicalUrl: read.canonicalUrl,
    cookieDomain: read.cookieDomain,
    loginReturnPath: loginReturnPath ?? "/",
    loginPageUrl,
    links: { docs: docs ?? DEFAULT_DOCS_URL, terms, privacy },
  };
}
