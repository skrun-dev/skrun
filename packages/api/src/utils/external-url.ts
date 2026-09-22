import { createLogger } from "@skrun-dev/runtime";
import type { Context } from "hono";

const logger = createLogger("external-url");

/**
 * Parse and validate the canonical public origin an operator configured.
 *
 * Throws, with a message naming the value received and what was expected. This is
 * the loud half of the pair below: it runs once, at startup, from `createApp`.
 *
 * Accepted: an absolute `http` or `https` URL, a port if you need one, and nothing
 * else — no path (a bare `/` is tolerated because `new URL` adds it), no query, no
 * fragment. Those are refused rather than ignored: a path in a value whose whole
 * job is to be an *origin* means the operator expected something we would silently
 * drop.
 */
export function parsePublicUrl(raw: string): URL {
  const expected =
    "an absolute http(s) origin with no path, query or fragment " +
    "(e.g. https://api.example.com or https://api.example.com:8443)";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SKRUN_PUBLIC_URL must be ${expected} — received "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `SKRUN_PUBLIC_URL must be ${expected} — received "${raw}" (scheme "${url.protocol.replace(":", "")}")`,
    );
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(
      `SKRUN_PUBLIC_URL must be ${expected} — received "${raw}" (it carries a path, query or fragment)`,
    );
  }
  return url;
}

/**
 * The canonical public origin, or `undefined` when none is configured.
 *
 * This is the quiet half of the pair: it is called on the request path, so it must
 * never throw — an exception here would turn a handler that hands out a URL today
 * into a 500. An unreadable value therefore falls through to the header derivation
 * below.
 *
 * That is **not** a silent catch, and the division of labour is the whole design:
 * `createApp` calls `parsePublicUrl()` at startup and refuses to boot on a bad
 * value, so by the time a request reaches this function the value has already been
 * validated once, loudly. The `catch` here only covers the case where something
 * mutated the environment after startup — and even then the fallback is the
 * behaviour this deployment had before the variable existed, never a wrong answer
 * dressed up as a right one.
 */
export function publicOrigin(): string | undefined {
  const raw = process.env.SKRUN_PUBLIC_URL?.trim();
  if (!raw) return undefined;
  try {
    return parsePublicUrl(raw).origin;
  } catch (err) {
    // Unreachable after a successful boot (the startup interlock validated the
    // same value), so if it ever fires the pinning has silently fallen back to
    // the proxy headers — the one thing the variable exists to prevent. Say so.
    logger.error(
      { event: "public_url_unreadable", error: err instanceof Error ? err.message : String(err) },
      "SKRUN_PUBLIC_URL is unreadable at request time; falling back to the proxy headers",
    );
    return undefined;
  }
}

/**
 * Build the externally-visible base URL (`scheme://host`) for the current request.
 *
 * Behind a TLS-terminating reverse proxy (Fly.io, Caddy, nginx, Cloudflare, …) the
 * app receives the request over plain HTTP internally, so `new URL(c.req.url).origin`
 * yields `http://…` even though the public site is `https://…`. That breaks any
 * externally-facing URL we hand out — most importantly the GitHub OAuth `redirect_uri`,
 * which GitHub matches scheme-exactly against the registered callback (an `http://`
 * value is rejected as "Invalid Redirect URI"). It also mislabels the OpenAPI `servers`
 * URL in the interactive docs.
 *
 * We trust the standard `X-Forwarded-Proto` (and the `Host`) header the proxy sets,
 * falling back to the request's own scheme/host for direct / localhost access (where
 * no proxy is in front). This is the conventional behaviour for an app that runs
 * behind a trusted proxy — which is every reachable Skrun deployment (Fly, or a
 * self-host reverse proxy). On localhost the request is already `http://localhost`,
 * so the fallback preserves the existing working behaviour.
 *
 * An operator can take that derivation out of the loop entirely by setting
 * `SKRUN_PUBLIC_URL` to the canonical public origin. When it is set it is the first
 * source and the headers above are never consulted, so the URL the server gives
 * itself no longer depends on `Host` — which is a value the caller chooses. That is
 * the point: a request carrying `Host: evil.example` can no longer steer the OAuth
 * `redirect_uri`, the device `verification_uri` or the published `servers` entry.
 */
export function externalBaseUrl(c: Context): string {
  const configured = publicOrigin();
  if (configured) return configured;
  const url = new URL(c.req.url);
  const proto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = c.req.header("host") || url.host;
  return `${proto}://${host}`;
}
