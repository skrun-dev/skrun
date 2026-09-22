import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, sessionCookieName } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { MemoryStorage } from "../storage/memory.js";

/**
 * The CSRF guard, exercised through the app `createApp` builds — not through the
 * middleware in isolation. The thing under test is a *shape of request* reaching
 * a real mount order (secure headers, CORS, the guard, the limiters, the
 * routers), and a hand-built app would prove nothing about that order.
 *
 * How a refusal is recognised, and why it takes two assertions. The library
 * answers a bare `403` whose body is exactly `Forbidden`; every `403` this app
 * produces itself is JSON `{ error: { code, … } }`. Asserting the status alone
 * would let an authorization refusal — `CSRF_FAILED` on the device form, a
 * namespace check, a master-credential check — pass for a CSRF refusal, and a
 * case would then go green for the wrong reason.
 */
async function guardRefused(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  return (await res.text()) === "Forbidden";
}

const KEYS = [
  "SKRUN_PUBLIC_URL",
  "SKRUN_SESSION_COOKIE_DOMAIN",
  "SKRUN_AGENTS_DIR",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;

describe("CSRF guard on cookie-authenticated mutations (#123)", () => {
  const snapshot: Record<string, string | undefined> = {};
  let app: ReturnType<typeof createApp>;
  let db: MemoryDb;
  let seq = 0;

  beforeEach(() => {
    for (const key of KEYS) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
    db = new MemoryDb();
    app = createApp(new MemoryStorage(), db);
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  /**
   * A signed-in browser. The session is created with the app's OWN adapter — a
   * second adapter would answer 401 for a reason that has nothing to do with the
   * guard, and the case would be measuring the wrong thing.
   */
  async function signIn(username = `u${++seq}`): Promise<{ id: string; cookie: string }> {
    const user = await db.createUser({ github_id: `gh-${username}`, username });
    const sessionId = await createSession(db, user.id);
    return { id: user.id, cookie: `${sessionCookieName()}=${sessionId}` };
  }

  /** Mints a real `sk_live_*` through the API, in a shape the guard lets past. */
  async function mintKey(cookie: string): Promise<string> {
    const res = await app.request("/api/keys", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "probe" }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).key;
  }

  // --- VT-12 — the refusal, on every mutation a cookie can authenticate -------

  // The forged shape, verbatim: a session cookie the browser attaches by itself,
  // a form-ish content type, no browser fetch-metadata, and an Origin that is not
  // ours. Every POST a cookie can authenticate has to refuse it — a list with one
  // hole is a list an attacker reads for the hole.
  it("VT-12: a simple-form POST from another origin is refused on all six cookie-authenticatable mutations", async () => {
    const { cookie } = await signIn();
    // scan's handler answers NOT_CONFIGURED without SKRUN_AGENTS_DIR, which does
    // not matter here: the guard fires before any handler runs. It matters for a
    // case that has to SUCCEED, and those use another route.
    const paths = [
      "/api/agents/alice/demo/push",
      "/api/agents/alice/demo/run",
      "/api/keys",
      "/api/files",
      "/api/agents/scan/demo/push",
      "/auth/logout",
    ];

    for (const path of paths) {
      const res = await app.request(path, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "text/plain",
          Origin: "https://evil.example",
        },
        body: "{}",
      });
      expect(res.status, path).toBe(403);
      expect(await res.text(), path).toBe("Forbidden");
    }
  });

  // --- VT-13 — no Content-Type at all ----------------------------------------

  // A request with no Content-Type is the one a reader assumes escapes a
  // form-shape check. It does not: the library substitutes `text/plain` for an
  // absent header, so the default is refusal and not admission.
  it("VT-13: a POST with no Content-Type at all is refused", async () => {
    const { cookie } = await signIn();
    const res = await app.request("/api/keys", { method: "POST", headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });

  // --- VT-14 / VT-16 — the two halves of the fetch-metadata signal -----------

  // The dashboard's file upload: multipart, which IS a form shape, saved by the
  // header the browser adds. Three of the dashboard's six mutation shapes depend
  // on this and on nothing else.
  it("VT-14: Sec-Fetch-Site: same-origin carries a multipart upload past the guard", async () => {
    const { cookie } = await signIn();
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));

    const res = await app.request("/api/files", {
      method: "POST",
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
      body: form,
    });
    expect(await guardRefused(res)).toBe(false);
    expect(res.status).toBe(201);
  });

  // The case that gives VT-14 its meaning. `same-site` is what a SIBLING HOST of
  // the shared domain sends — the whole attack this element exists for. Accepting
  // it would make the guard agree with `SameSite=Lax`, which is the thing that
  // stopped filtering.
  it("VT-16: Sec-Fetch-Site: same-site is refused — that is the sibling host", async () => {
    const { cookie } = await signIn();
    const res = await app.request("/api/keys", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
        "Sec-Fetch-Site": "same-site",
      },
      body: "name=k",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
  });

  // --- VT-17 — a non-simple content type cannot be forged --------------------

  // Neither of these two shapes can be produced cross-origin without a preflight,
  // and the preflight cannot succeed while the CORS mount carries no credentials.
  // No fetch-metadata, no Origin: they pass on the content type alone.
  it("VT-17: application/json and application/octet-stream pass with no browser signal at all", async () => {
    const { cookie } = await signIn();

    const json = await app.request("/api/keys", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "json-shape" }),
    });
    expect(await guardRefused(json)).toBe(false);
    expect(json.status).toBe(201);

    const octet = await app.request("/api/agents/alice/demo/push", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/octet-stream" },
      body: new Uint8Array([0x1f, 0x8b, 0x00]),
    });
    // The push itself fails on the bundle, which is not what is measured: what is
    // measured is that the refusal did not come from the guard.
    expect(await guardRefused(octet)).toBe(false);
  });

  // --- VT-18 — the guard does not arm without a cookie -----------------------

  // The contract break this guard must never become: `curl -X POST -d …` with a
  // valid key sends the simplest possible shape and no browser signal. Nothing
  // about it is forgeable — a third-party page cannot mint that Authorization
  // header — so the guard has to stay out of the way.
  it("VT-18: a key-holding caller with no cookie and a form-encoded body is untouched", async () => {
    const { cookie } = await signIn();
    const key = await mintKey(cookie);

    const res = await app.request("/api/agents/alice/demo/run", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "input=hello",
    });
    expect(await guardRefused(res)).toBe(false);
  });

  // --- VT-39 — the command the documentation teaches -------------------------

  // `curl -d` sends application/x-www-form-urlencoded. The documented
  // cookie-authenticated key-minting command is therefore exactly the shape the
  // guard refuses, and it only ever worked because Hono's json() ignores the
  // content type. Seen refused here BEFORE the documentation is corrected, and
  // seen working in the corrected form.
  it("VT-39: the documented cookie curl is refused, and the corrected one answers 201", async () => {
    const { cookie } = await signIn();

    const asDocumented = await app.request("/api/keys", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: JSON.stringify({ name: "from-curl" }),
    });
    expect(asDocumented.status).toBe(403);
    expect(await asDocumented.text()).toBe("Forbidden");

    const corrected = await app.request("/api/keys", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "from-curl" }),
    });
    expect(corrected.status).toBe(201);
  });

  // --- VT-37 — Authorization exempts, and the cookie still wins the identity --

  // Two things at once, and the second is the one worth writing down. The
  // exemption means a caller who drags a stale cookie along is not refused; but
  // when that cookie is VALID the auth chain still prefers it, so the request
  // acts as the cookie's owner and not as the key's. That is acceptable — only a
  // non-browser client already holding the session can build this request — but
  // it is asserted rather than discovered later.
  it("VT-37: an Authorization header exempts the request, with an invalid cookie and with a valid one", async () => {
    const keyOwner = await signIn("keyowner");
    const key = await mintKey(keyOwner.cookie);
    const cookieOwner = await signIn("cookieowner");

    const stale = await app.request("/api/agents/alice/demo/run", {
      method: "POST",
      headers: {
        Cookie: `${sessionCookieName()}=00000000-0000-4000-8000-000000000000`,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "input=hello",
    });
    expect(await guardRefused(stale)).toBe(false);

    const both = await app.request("/api/keys", {
      method: "POST",
      headers: {
        Cookie: cookieOwner.cookie,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: JSON.stringify({ name: "identity-probe" }),
    });
    expect(await guardRefused(both)).toBe(false);
    expect(both.status).toBe(201);
    const minted = await both.json();

    // The minted key belongs to the COOKIE's owner: it is listed for that
    // session, and absent from the key owner's own listing.
    const byCookie = await app.request("/api/keys", { headers: { Cookie: cookieOwner.cookie } });
    expect((await byCookie.json()).map((k: { id: string }) => k.id)).toContain(minted.id);
    const byKey = await app.request("/api/keys", { headers: { Authorization: `Bearer ${key}` } });
    expect((await byKey.json()).map((k: { id: string }) => k.id)).not.toContain(minted.id);
  });

  // --- VT-40 — only the Bearer form exempts -----------------------------------

  // A browser can attach `Authorization: Basic` to a top-level navigation on its
  // own (credentials in the URL), and that path is not preflighted. So any
  // scheme other than Bearer must arm the guard exactly as if the header were
  // absent — otherwise the exemption is wider than the argument that justifies it.
  it("VT-40: an Authorization header that is not Bearer does not exempt the request", async () => {
    const owner = await signIn("basicowner");
    for (const value of ["Basic YTpi", "x"]) {
      const res = await app.request("/api/keys", {
        method: "POST",
        headers: {
          Cookie: owner.cookie,
          Authorization: value,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: JSON.stringify({ name: "basic-probe" }),
      });
      expect(await guardRefused(res)).toBe(true);
    }
  });

  // --- RT-2 / RT-3 — no API contract is broken -------------------------------

  // Every mutating route in the app, called the way a script calls it: a key, the
  // simplest body shape, no cookie and no browser signal. Not one of them may
  // answer the guard's refusal. The list is the mount patterns as they stand
  // today; a route added later without a line here is the drift this case cannot
  // catch, which is why the guard's mount is `*` and not a route list.
  it("RT-2: none of the 14 mutating routes refuses a key-holding caller sending a simple form", async () => {
    const { cookie } = await signIn();
    const key = await mintKey(cookie);
    const calls: Array<[string, string]> = [
      ["POST", "/api/agents/alice/demo/push"],
      ["PATCH", "/api/agents/alice/demo/versions/1.0.0/verify"],
      ["PATCH", "/api/agents/alice/demo/visibility"],
      ["DELETE", "/api/agents/alice/demo/versions/1.0.0"],
      ["DELETE", "/api/agents/alice/demo"],
      ["POST", "/api/agents/alice/demo/run"],
      ["POST", "/api/keys"],
      ["DELETE", "/api/keys/some-key-id"],
      ["POST", "/api/files"],
      ["DELETE", "/api/files/some-file-id"],
      ["PUT", "/api/agents/alice/demo/llm-keys/openai"],
      ["DELETE", "/api/agents/alice/demo/llm-keys/openai"],
      ["PUT", "/api/agents/alice/demo/llm-key-policy"],
      ["POST", "/api/agents/scan/demo/push"],
    ];

    for (const [method, path] of calls) {
      const res = await app.request(path, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: method === "DELETE" ? undefined : "x=1",
      });
      expect(await guardRefused(res), `${method} ${path}`).toBe(false);
    }
  });

  // The self-host operator's shortcut, which is a bearer token but not a key.
  // It takes the same exemption, for the same reason.
  it("RT-3: a Bearer dev-token caller sending a simple form is untouched", async () => {
    const res = await app.request("/api/keys", {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-token",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "name=dev",
    });
    expect(await guardRefused(res)).toBe(false);
  });

  // --- RT-8 replayed — the dashboard's six mutation shapes -------------------

  // Synthetic requests reproducing what the browser sends from each of the six
  // sites that mutate. They are named by site so that a shape which later changes
  // in the dashboard can be traced back to the case that covers it. Four of the
  // six are carried by Sec-Fetch-Site alone (the two JSON-shaped ones never arm the
  // guard) — that is the dependency worth seeing written down.
  it("RT-8: the six dashboard mutation shapes all pass, each named by its call site", async () => {
    const { cookie } = await signIn();
    const browser = { Cookie: cookie, "Sec-Fetch-Site": "same-origin" };

    // api-client.ts:204 — apiFetch always sets application/json.
    const jsonPost = await app.request("/api/keys", {
      method: "POST",
      headers: { ...browser, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dashboard key" }),
    });
    expect(await guardRefused(jsonPost), "api-client.ts:204").toBe(false);
    expect(jsonPost.status).toBe(201);
    const keyId = (await jsonPost.json()).id;

    // api-client.ts:559 — the push body goes up as application/octet-stream.
    const push = await app.request("/api/agents/alice/demo/push", {
      method: "POST",
      headers: { ...browser, "Content-Type": "application/octet-stream" },
      body: new Uint8Array([0x1f, 0x8b, 0x00]),
    });
    expect(await guardRefused(push), "api-client.ts:559").toBe(false);

    // api-client.ts:376 (and :509, :620) — apiFetchRaw DELETEs with no body and
    // therefore no Content-Type. Form shape by default; only the header saves it.
    const del = await app.request(`/api/keys/${keyId}`, { method: "DELETE", headers: browser });
    expect(await guardRefused(del), "api-client.ts:376").toBe(false);
    expect(del.status).toBe(204);

    // lib/auth.tsx:98 — sign-out, a POST with no body and no Content-Type.
    const logout = await app.request("/auth/logout", { method: "POST", headers: browser });
    expect(await guardRefused(logout), "lib/auth.tsx:98").toBe(false);
    expect(logout.status).toBe(200);

    // pages/playground.tsx:34 — a FormData body, i.e. multipart/form-data.
    const upload = await signIn().then(async ({ cookie: fresh }) => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array([4, 5])], "b.png", { type: "image/png" }));
      return app.request("/api/files", {
        method: "POST",
        headers: { Cookie: fresh, "Sec-Fetch-Site": "same-origin" },
        body: form,
      });
    });
    expect(await guardRefused(upload), "pages/playground.tsx:34").toBe(false);
    expect(upload.status).toBe(201);

    // routes/auth.ts — the device consent page's own top-level form POST. It is
    // the most exposed of the six: a form navigation, url-encoded, and carrying
    // the session cookie of a signed-in operator, so the guard DOES arm on it.
    // Its own double-submit token is unaffected and still has to be right.
    const consentPage = await app.request("/device?user_code=ABCD-2345");
    const deviceCsrf =
      consentPage.headers.get("Set-Cookie")?.match(/skrun_device_csrf=([^;]+)/)?.[1] ?? "";
    expect(deviceCsrf).not.toBe("");
    const consent = await app.request("/device", {
      method: "POST",
      headers: {
        Cookie: `${cookie}; skrun_device_csrf=${deviceCsrf}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Sec-Fetch-Site": "same-origin",
      },
      body: `user_code=ABCD-2345&csrf=${deviceCsrf}`,
      redirect: "manual",
    });
    expect(await guardRefused(consent), "routes/auth.ts device form").toBe(false);
  });
});

/**
 * VT-15 lives in its own block because it needs the app built with a canonical
 * origin configured, which is read once at startup.
 */
describe("CSRF guard — the expected origin comes from the configuration (#123)", () => {
  const KEYS_15 = ["SKRUN_PUBLIC_URL", "SKRUN_SESSION_COOKIE_DOMAIN"] as const;
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS_15) {
      snapshot[key] = process.env[key];
    }
    process.env.SKRUN_PUBLIC_URL = "https://api.example.com";
    delete process.env.SKRUN_SESSION_COOKIE_DOMAIN;
  });

  afterEach(() => {
    for (const key of KEYS_15) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  // The one case that proves the expected origin is NOT derived from the request.
  // The Host header says one thing, the configuration says another, and the
  // Origin matches the configuration: it must pass. Under the library's default
  // comparison — against the origin of the request URL — it would not, and the
  // guard would then be resting entirely on Sec-Fetch-Site, which this request
  // deliberately does not send.
  it("VT-15: a canonical Origin passes even when the Host header disagrees", async () => {
    const db = new MemoryDb();
    const app = createApp(new MemoryStorage(), db);
    const user = await db.createUser({ github_id: "gh-origin", username: "origin" });
    const cookie = `${sessionCookieName()}=${await createSession(db, user.id)}`;

    const res = await app.request("/api/keys", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "text/plain",
        Origin: "https://api.example.com",
        Host: "internal.local",
      },
      body: JSON.stringify({ name: "by-origin" }),
    });
    expect(await guardRefused(res)).toBe(false);
    // It reached the handler and was served — Hono's json() does not police the
    // content type, which is also why the documented curl used to work.
    expect(res.status).toBe(201);
  });
});
