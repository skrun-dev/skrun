import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { sessionCookieName } from "../auth/session.js";
import { externalBaseUrl } from "../utils/external-url.js";

/**
 * CSRF protection for mutations that are authenticated by the session cookie.
 *
 * Why this exists at all: the session cookie is `SameSite=Lax`, and `Lax`
 * compares *sites*, not hosts. The moment the API answers under the same site
 * as the product — two hosts of one shared domain — a sibling host can make the
 * browser send that cookie on a cross-host form post, and nothing else in this
 * app would stop it. The guard applies unconditionally, including on a
 * single-domain self-host, because a browser extension or an injected page on
 * any same-site host is the same shape of request.
 *
 * The wrapper is three lines of predicate around hono's `csrf()`. The predicate
 * is the whole design: the library middleware refuses a "simple" request shape
 * (a form-ish `Content-Type`, or none) that carries neither `Sec-Fetch-Site:
 * same-origin` nor an acceptable `Origin`. Applied to everything, that would
 * refuse `curl -X POST -d …` from a caller holding a valid API key — a contract
 * break for a legitimate non-browser client. So the guard arms only on requests
 * that actually present a session cookie and nothing stronger.
 *
 * A refusal from here is `403` with the body `Forbidden` (the library's own
 * response), which is deliberately distinguishable from this app's `403`s: those
 * are JSON `{ error: { code, … } }`.
 */
export function createCsrfGuard(opts: { canonicalOrigin?: string }): MiddlewareHandler {
  const inner = csrf({
    // (1) `origin` is a FUNCTION, not a string, and that is not a style choice.
    //     The string form of `csrf()` freezes one value at construction time.
    //     With no canonical origin configured, the expected origin has to be
    //     derived per request from the incoming headers, which only the function
    //     form can do — it is handed the context.
    origin: (origin, c) => origin === (opts.canonicalOrigin ?? new URL(externalBaseUrl(c)).origin),

    // (2) Why the library default is NOT good enough, and would be worse than no
    //     comparison at all. The default compares to `new URL(c.req.url).origin`
    //     — an origin derived from the request as the *server* sees it. Behind a
    //     TLS-terminating proxy that URL carries the INTERNAL scheme (`http://`),
    //     so it would be compared against the browser's `https://…` and would
    //     never match. The guard would then be carried entirely by
    //     `Sec-Fetch-Site`: it would appear to work, for a reason that is not the
    //     one anybody believes. This repository has already seen an origin check
    //     compared against a derived value fail on a real deployment, and the
    //     check was removed rather than fixed. Passing the origin explicitly is
    //     what keeps that from repeating.
    //
    // (3) Why the derived FALLBACK is still acceptable when nothing is
    //     configured. A derived comparison can only ever produce a false
    //     REFUSAL, never a forged acceptance: the browser writes `Origin` and
    //     `Host` itself, an attacking page chooses neither, and a client that
    //     forges both is not a browser — so it does not have the cookie. The
    //     risk the derivation carries is rejecting legitimate traffic, which is
    //     exactly what the canonical origin removes when an operator sets it.

    // `secFetchSite` stays at its default, `"same-origin"`. Widening it to
    // `"same-site"` would accept precisely the attack this guard exists for: a
    // request from a sibling host of the shared domain.
  });

  return async (c, next) => {
    // (4) Why an `Authorization` header is exempt, and why the exemption is safe.
    //     Such a header makes the request non-simple, so a browser sends it
    //     cross-origin only after a preflight — and this app's CORS is mounted
    //     without credentials, so that preflight cannot succeed with a cookie
    //     attached. A request carrying `Authorization` therefore is never a
    //     forgery from a third-party site. The exemption also protects a
    //     legitimate caller: a `curl` holding an API key that happens to drag a
    //     stale session cookie along (shared browser profile, corporate proxy)
    //     must not be refused. Arming on the mere PRESENCE of a cookie would
    //     have broken it. That dependency on the CORS setting is real and is
    //     pinned by a behavioural test of the preflight.
    //     ONLY the `Bearer` form is exempt — the only form the auth chain reads.
    //     The preflight argument covers a header set by script; it does not
    //     cover `Authorization: Basic`, which a browser can attach on its own to
    //     a top-level navigation (credentials in the URL) with no preflight at
    //     all. Exempting any value would have opened that door.
    if (/^Bearer\s/i.test(c.req.header("Authorization") ?? "")) return next();

    // Nothing to protect: without the session cookie there is no ambient
    // credential for a third-party site to spend.
    if (!getCookie(c, sessionCookieName())) return next();

    return inner(c, next);
  };
}
