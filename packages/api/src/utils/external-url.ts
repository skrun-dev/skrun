import type { Context } from "hono";

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
 */
export function externalBaseUrl(c: Context): string {
  const url = new URL(c.req.url);
  const proto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = c.req.header("host") || url.host;
  return `${proto}://${host}`;
}
