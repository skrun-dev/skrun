import { INLINE_BASE64_MAX_BYTES } from "@skrun-dev/runtime";
import { packAgentTar } from "@skrun-dev/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key.js";
import { sessionCookieName } from "../auth/session.js";
import { MemoryDb } from "../db/memory.js";
import { createApp } from "../index.js";
import { minimalAgentYaml, validBundleOfSize } from "../routes/agent-bundle.shared.js";
import { MemoryStorage } from "../storage/memory.js";
import { RUN_BODY_MAX_BYTES } from "./body-limit.js";

// The app's error handler logs through the runtime's logger, which pino writes
// to the file descriptor directly: the factory is replaced to read the lines.
// Hoisted above the imports, so the module-level loggers are the spies.
const { logErrorSpy } = vi.hoisted(() => ({ logErrorSpy: vi.fn() }));
vi.mock("@skrun-dev/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@skrun-dev/runtime")>();
  const quiet = () => {};
  const levels = {
    info: quiet,
    warn: quiet,
    error: logErrorSpy,
    debug: quiet,
    trace: quiet,
    fatal: quiet,
  };
  return { ...actual, createLogger: () => ({ ...levels, level: "info", child: () => levels }) };
});

/**
 * Request-body caps: one table, one cap per route, a default for every other
 * route that reads a body. A declared Content-Length over the cap is refused on
 * the header alone; a body without one is counted while the ROUTE reads it, so
 * nothing is read — let alone held — before the route's own authentication.
 */

const MIB = 1024 * 1024;
const CHUNK = 64 * 1024;
const DEV = { Authorization: "Bearer dev-token" };

/**
 * A body the server pulls from, one 64 KiB chunk per pull, with no
 * Content-Length. `pulled()` says how many bytes were handed out: a stream
 * keeps one chunk in reserve as soon as it is built, so a body nobody reads
 * shows exactly one chunk pulled.
 */
function pullBody(total: number, head = "") {
  const prefix = new TextEncoder().encode(head);
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) {
        controller.close();
        return;
      }
      const len = Math.min(CHUNK, total - pulled);
      const chunk = new Uint8Array(len).fill(0x61);
      if (pulled === 0) chunk.set(prefix.subarray(0, len));
      controller.enqueue(chunk);
      pulled += len;
    },
  });
  return { stream, pulled: () => pulled };
}

function app() {
  return createApp(new MemoryStorage(), new MemoryDb(), { verificationPolicy: "admin" });
}

function post(
  target: ReturnType<typeof createApp>,
  path: string,
  body: ReadableStream<Uint8Array> | Uint8Array | string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return target.request(path, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

async function error(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the default cap on routes that read a body without authentication", () => {
  const ROUTES: Array<[string, string]> = [
    ["/auth/device/code", "application/json"],
    ["/device", "application/x-www-form-urlencoded"],
    ["/auth/device/token", "application/json"],
  ];

  it.each(
    ROUTES,
  )("%s refuses a body over 1 MB with 413 REQUEST_TOO_LARGE, counted without a Content-Length", async (path, type) => {
    // The code route only reads its body once sign-in is configured.
    vi.stubEnv("GITHUB_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
    const body = pullBody(4 * MIB);
    const res = await post(app(), path, body.stream, { "Content-Type": type });
    expect(res.status).toBe(413);
    const err = await error(res);
    expect(err.code).toBe("REQUEST_TOO_LARGE");
    expect(err.message).toContain(`${MIB} bytes`);
    // The read stopped at the cap: the rest of the body was never pulled.
    expect(body.pulled()).toBeLessThan(4 * MIB);
    expect(body.pulled()).toBeLessThanOrEqual(MIB + 2 * CHUNK);
  });

  it.each(
    ROUTES,
  )("%s refuses a declared Content-Length over 1 MB without reading the body", async (path, type) => {
    vi.stubEnv("GITHUB_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
    const body = pullBody(MIB + 1);
    const res = await post(app(), path, body.stream, {
      "Content-Type": type,
      "Content-Length": String(MIB + 1),
    });
    expect(res.status).toBe(413);
    expect((await error(res)).code).toBe("REQUEST_TOO_LARGE");
    expect(body.pulled()).toBe(CHUNK);
  });

  it("a body under the default cap reaches the route", async () => {
    const res = await post(app(), "/auth/device/token", JSON.stringify({}), {
      "Content-Type": "application/json",
    });
    expect(res.status).toBe(400);
    expect((await error(res)).code).toBe("invalid_request");
  });
});

describe("the push keeps its own cap", () => {
  it("a 2 MB bundle is pushed: the default cap does not apply to the push", async () => {
    const res = await post(
      app(),
      "/api/agents/dev/big-agent/push?version=1.0.0",
      new Uint8Array(await validBundleOfSize(2 * MIB, "big-agent")),
      { ...DEV, "Content-Type": "application/octet-stream" },
    );
    expect(res.status).toBe(200);
  });

  it("a push over its own cap is refused 413 BUNDLE_TOO_LARGE, with its message unchanged", async () => {
    vi.stubEnv("SKRUN_PUSH_MAX_BODY_MB", "1");
    const body = pullBody(4 * MIB);
    const res = await post(app(), "/api/agents/dev/big-agent/push?version=1.0.0", body.stream, {
      ...DEV,
      "Content-Type": "application/octet-stream",
    });
    expect(res.status).toBe(413);
    expect(await error(res)).toEqual({
      code: "BUNDLE_TOO_LARGE",
      message:
        "Bundle exceeds the 1 MB request-body cap (compressed). Set SKRUN_PUSH_MAX_BODY_MB to adjust, and BUNDLE_MAX_DECOMPRESSED_MB with it: a bundle that unpacks past that cap is refused too.",
    });
    expect(body.pulled()).toBeLessThan(4 * MIB);
  });
});

describe("the run route's cap is derived from the inline file cap", () => {
  const RUN = "/api/agents/dev/missing-agent/run";
  const JSON_TYPE = { ...DEV, "Content-Type": "application/json" };

  /** A JSON body of exactly `size` bytes carrying the given base64 pieces. */
  function runBody(size: number, pieces: string[]): string {
    const head = JSON.stringify({
      input: { files: pieces.map((data) => ({ type: "base64", media_type: "image/png", data })) },
    });
    const skeleton = `${head.slice(0, -1)},"pad":""}`;
    const pad = size - Buffer.byteLength(skeleton);
    expect(pad).toBeGreaterThanOrEqual(0);
    return `${head.slice(0, -1)},"pad":"${"x".repeat(pad)}"}`;
  }

  it("the cap is the base64 size of the inline cap plus 1 MB for the rest of the request", () => {
    expect(RUN_BODY_MAX_BYTES).toBe(Math.ceil((INLINE_BASE64_MAX_BYTES * 4) / 3) + MIB);
  });

  it("one byte over the cap is refused 413 REQUEST_TOO_LARGE, with or without a Content-Length", async () => {
    const declared = await post(app(), RUN, "x".repeat(RUN_BODY_MAX_BYTES + 1), {
      ...JSON_TYPE,
      "Content-Length": String(RUN_BODY_MAX_BYTES + 1),
    });
    expect(declared.status).toBe(413);
    const counted = await post(app(), RUN, pullBody(RUN_BODY_MAX_BYTES + 1).stream, JSON_TYPE);
    expect(counted.status).toBe(413);
    const err = await error(counted);
    expect(err.code).toBe("REQUEST_TOO_LARGE");
    expect(err.message).toContain(`${RUN_BODY_MAX_BYTES} bytes`);
  });

  it("a body of exactly the cap, carrying an inline file at the inline cap, reaches the route", async () => {
    const piece = Buffer.alloc(INLINE_BASE64_MAX_BYTES, 7).toString("base64");
    const res = await post(app(), RUN, runBody(RUN_BODY_MAX_BYTES, [piece]), JSON_TYPE);
    // Past the cap, the route answers for the agent: it does not exist.
    expect(res.status).toBe(404);
  });

  it("two inline pieces of 2 MB each reach the route: the cap bounds their sum", async () => {
    const piece = Buffer.alloc(2 * MIB, 7).toString("base64");
    const body = runBody(2 * piece.length + 1024, [piece, piece]);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(RUN_BODY_MAX_BYTES);
    const res = await post(app(), RUN, body, JSON_TYPE);
    expect(res.status).toBe(404);
  });

  // Nothing keeps the 1 MB meant for the rest of the request: base64 can take
  // it, so what the cap leaves to the inline files of one request is three
  // quarters of it decoded — more than the 4 MB of one piece, about 4.75 MB when
  // the rest is small. Measured on both sides, in fixed sizes.
  function twoPieces(each: number): string {
    const data = Buffer.alloc(each, 7).toString("base64");
    return JSON.stringify({
      input: {
        files: [data, data].map((d) => ({ type: "base64", media_type: "image/png", data: d })),
      },
    });
  }

  it("inline files can total more than 4 MB decoded: two pieces, 4.74 MB together, reach the route", async () => {
    const each = 2_485_125;
    const res = await post(app(), RUN, twoPieces(each), JSON_TYPE);
    expect(res.status).toBe(404);
    expect(2 * each).toBeGreaterThan(INLINE_BASE64_MAX_BYTES);
  });

  it("two pieces of 4.75 MB together do not fit: three quarters of the cap, decoded, is the bound", async () => {
    const each = 2_490_371;
    const res = await post(app(), RUN, twoPieces(each), JSON_TYPE);
    expect(res.status).toBe(413);
    expect((await error(res)).code).toBe("REQUEST_TOO_LARGE");
    expect(2 * each).toBeGreaterThan(Math.floor((RUN_BODY_MAX_BYTES * 3) / 4));
  });

  it("a route that turns an unreadable body into 400 still answers the cap's 413", async () => {
    const res = await post(app(), RUN, pullBody(RUN_BODY_MAX_BYTES + 4 * CHUNK).stream, JSON_TYPE);
    expect(res.status).toBe(413);
    expect((await error(res)).code).toBe("REQUEST_TOO_LARGE");
  });
});

describe("the 413 that replaces a route's answer", () => {
  const RUN = "/api/agents/cap/some-agent/run";

  it("keeps the cookies set before the route — a duplicated session cookie's erasure survives it", async () => {
    // The configuration where a duplicated session cookie is refused and erased:
    // production, a shared cookie domain. Signed in by an API key.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGIN", "https://app.example.com");
    vi.stubEnv("SKRUN_PUBLIC_URL", "https://api.example.com");
    vi.stubEnv("SKRUN_SESSION_COOKIE_DOMAIN", "example.com");
    vi.stubEnv("GITHUB_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
    const db = new MemoryDb();
    const target = createApp(new MemoryStorage(), db, { verificationPolicy: "admin" });
    const user = await db.createUser({ github_id: "gh-cap", username: "cap" });
    const { key, keyHash, keyPrefix } = generateApiKey();
    await db.createApiKey({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: "k",
    });
    const name = sessionCookieName();
    expect(name).toBe("__Secure-skrun_session");
    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Cookie: `${name}=one; ${name}=two`,
    };

    // The same request with a body under the cap: the route's own answer, and
    // the erasure the authentication wrote before it.
    const kept = await post(target, RUN, JSON.stringify({ input: {} }), headers);
    expect(kept.status).toBe(404);
    const erasure = kept.headers.getSetCookie();
    expect(erasure.length).toBeGreaterThan(0);

    const replaced = await post(
      target,
      RUN,
      pullBody(RUN_BODY_MAX_BYTES + 4 * CHUNK).stream,
      headers,
    );
    expect(replaced.status).toBe(413);
    expect((await error(replaced)).code).toBe("REQUEST_TOO_LARGE");
    expect(replaced.headers.getSetCookie()).toEqual(erasure);
  });

  it("carries no length measured on the route's answer", async () => {
    const target = app();
    // A route that answers a failed read with a length of its own.
    target.post("/length-probe", async (c) => {
      try {
        await c.req.text();
      } catch {
        // the read fails past the cap
      }
      return c.body("bad", 400, { "Content-Length": "3" });
    });
    const res = await post(target, "/length-probe", pullBody(2 * MIB).stream);
    expect(res.status).toBe(413);
    expect(res.headers.get("content-length")).toBeNull();
    expect((await error(res)).code).toBe("REQUEST_TOO_LARGE");
  });

  it("an over-cap read a route lets escape is answered 413 by the app, and logged as nothing unhandled", async () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
    logErrorSpy.mockClear();
    // The consent route reads its form without catching: the read's error
    // leaves the route.
    const res = await post(app(), "/device", pullBody(4 * MIB).stream, {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(res.status).toBe(413);
    expect((await error(res)).code).toBe("REQUEST_TOO_LARGE");
    const unhandled = logErrorSpy.mock.calls.filter(
      ([fields]) => (fields as { event?: string } | undefined)?.event === "unhandled_error",
    );
    expect(unhandled).toEqual([]);
  });
});

describe("the upload route's cap: the file limit plus 1 MB of multipart framing", () => {
  const BOUNDARY = "----skrun-cap-test";
  const MULTIPART = { ...DEV, "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` };
  const HEAD = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`;

  it("a 2 MB upload is accepted: the default cap does not apply to the upload", async () => {
    vi.stubEnv("SKRUN_MAX_BODY_MB", "1");
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(2 * MIB).fill(1)], "two.png", { type: "image/png" }),
    );
    const res = await app().request("/api/files", { method: "POST", headers: DEV, body: form });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { size: number }).size).toBe(2 * MIB);
  });

  it("a file of exactly the file limit is accepted, with or without a Content-Length: its framing fits in the cap", async () => {
    vi.stubEnv("INPUT_FILES_MAX_SIZE_MB", "1");
    const form = new FormData();
    form.append("file", new File([new Uint8Array(MIB).fill(1)], "max.png", { type: "image/png" }));
    const encoded = new Request("http://localhost/", { method: "POST", body: form });
    const type = encoded.headers.get("content-type") ?? "";
    const body = new Uint8Array(await encoded.arrayBuffer());
    const target = app();
    for (const declared of [{}, { "Content-Length": String(body.byteLength) }]) {
      const res = await post(target, "/api/files", body, {
        ...DEV,
        "Content-Type": type,
        ...declared,
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { size: number }).size).toBe(MIB);
    }
    // What the cap leaves room for: the body is the file and its framing.
    expect(body.byteLength).toBeGreaterThan(MIB);
  });

  it("an upload over the cap is refused 413 FILE_TOO_LARGE before it is read whole", async () => {
    vi.stubEnv("INPUT_FILES_MAX_SIZE_MB", "1");
    const body = pullBody(8 * MIB, HEAD);
    const res = await post(app(), "/api/files", body.stream, MULTIPART);
    expect(res.status).toBe(413);
    expect((await error(res)).code).toBe("FILE_TOO_LARGE");
    expect(body.pulled()).toBeLessThanOrEqual(2 * MIB + 2 * CHUNK);
  });

  it("a declared Content-Length over the cap is refused without reading the body", async () => {
    vi.stubEnv("INPUT_FILES_MAX_SIZE_MB", "1");
    const body = pullBody(2 * MIB + 1, HEAD);
    const res = await post(app(), "/api/files", body.stream, {
      ...MULTIPART,
      "Content-Length": String(2 * MIB + 1),
    });
    expect(res.status).toBe(413);
    expect((await error(res)).code).toBe("FILE_TOO_LARGE");
    expect(body.pulled()).toBe(CHUNK);
  });
});

describe("the default cap is an operator setting, refused at boot when malformed", () => {
  it.each([
    "abc",
    "0",
    "-1",
    "",
    // Read as numbers by `Number`, and not what an operator writes for a size.
    "0x10",
    "1e3",
    // Positive, and under one byte: a cap that would refuse every body.
    "0.0000001",
  ])("SKRUN_MAX_BODY_MB=%j refuses to start, naming the variable", (raw) => {
    vi.stubEnv("SKRUN_MAX_BODY_MB", raw);
    expect(() => app()).toThrow(/SKRUN_MAX_BODY_MB must be a positive decimal number of MB/);
  });

  it.each([
    "0x10",
    "1e3",
    "0.0000001",
  ])("SKRUN_PUSH_MAX_BODY_MB=%j refuses to start as well", (raw) => {
    vi.stubEnv("SKRUN_PUSH_MAX_BODY_MB", raw);
    expect(() => app()).toThrow(/SKRUN_PUSH_MAX_BODY_MB must be a positive decimal number of MB/);
  });

  it.each(["0.5", "2.", ".5", "1"])("SKRUN_MAX_BODY_MB=%j is read", (raw) => {
    vi.stubEnv("SKRUN_MAX_BODY_MB", raw);
    expect(() => app()).not.toThrow();
  });

  it("a value with spaces around it is read", async () => {
    vi.stubEnv("SKRUN_MAX_BODY_MB", " 2 ");
    const target = app();
    const under = await post(target, "/auth/device/token", pullBody(MIB + CHUNK).stream, {
      "Content-Type": "application/json",
    });
    expect(under.status).toBe(400);
    const over = await post(target, "/auth/device/token", pullBody(2 * MIB + CHUNK).stream, {
      "Content-Type": "application/json",
    });
    expect(over.status).toBe(413);
    expect((await error(over)).message).toContain(`${2 * MIB} bytes`);
  });
});

// Its twin bounds what the push's archive expands to: read the same way, by
// the same function, and once at startup — a malformed value is not an absent
// one, and never the default in its place.
describe("the decompression cap is read as the push's body cap, refused at boot when malformed", () => {
  it.each([
    "",
    " ",
    "abc",
    "0",
    "-5",
    "0x10",
    "1e3",
    "80MB",
    "0.0000001",
  ])("BUNDLE_MAX_DECOMPRESSED_MB=%j refuses to start, naming the variable", (raw) => {
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", raw);
    expect(() => app()).toThrow(
      `BUNDLE_MAX_DECOMPRESSED_MB must be a positive decimal number of MB (got "${raw}"). Unset it to use the 50 MB default.`,
    );
  });

  it.each(["0.5", "2.", ".5", "1", " 60 "])("BUNDLE_MAX_DECOMPRESSED_MB=%j is read", (raw) => {
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", raw);
    expect(() => app()).not.toThrow();
  });

  it("a fraction of a MB is a cap in whole bytes: 0.5 refuses a bundle that unpacks past 524,288", async () => {
    vi.stubEnv("BUNDLE_MAX_DECOMPRESSED_MB", "0.5");
    const target = app();
    const push = (bundle: Buffer) =>
      post(target, "/api/agents/dev/half/push?version=1.0.0", new Uint8Array(bundle), {
        ...DEV,
        "Content-Type": "application/octet-stream",
      });
    const files = (bytes: number) => [
      { name: "agent.yaml", content: Buffer.from(minimalAgentYaml("half")) },
      { name: "SKILL.md", content: Buffer.from("# half\n") },
      { name: "data/blob.bin", content: Buffer.alloc(bytes) },
    ];

    const over = await push(await packAgentTar(files(600 * 1024)));
    expect(over.status).toBe(413);
    expect(await error(over)).toEqual({
      code: "BUNDLE_DECOMPRESSED_TOO_LARGE",
      message:
        "This bundle decompresses to more than 0.5 MB, the most this server unpacks (BUNDLE_MAX_DECOMPRESSED_MB). Make the agent smaller — leave out the files it does not need when it runs — and push it again; the server's operator can raise BUNDLE_MAX_DECOMPRESSED_MB.",
    });
    expect((await push(await packAgentTar(files(400 * 1024)))).status).toBe(200);
  });
});

describe("nothing is read before the route's authentication", () => {
  const TARGETS: Array<[string, string]> = [
    ["/api/files", "multipart/form-data; boundary=x"],
    ["/api/agents/dev/some-agent/run", "application/json"],
    ["/api/agents/dev/some-agent/push?version=1.0.0", "application/octet-stream"],
  ];

  it.each(
    TARGETS,
  )("an unauthenticated 26 MB body without Content-Length on %s gets 401, its stream left untouched", async (path, type) => {
    const body = pullBody(26 * MIB);
    const res = await post(app(), path, body.stream, { "Content-Type": type });
    expect(res.status).toBe(401);
    // One chunk: the reserve the stream filled when it was built. Nothing was
    // pulled on the server's side.
    expect(body.pulled()).toBe(CHUNK);
  });
});

describe("a method that carries no body is handed on as it came", () => {
  // A GET or a HEAD can still arrive with a framing header. A request with a
  // body cannot be built for either, so the cap leaves them alone.
  it.each([
    ["GET", "Content-Length", "10"],
    ["GET", "Transfer-Encoding", "chunked"],
    ["HEAD", "Content-Length", "10"],
    ["HEAD", "Transfer-Encoding", "chunked"],
  ])("%s /health with %s: %s reaches the route", async (method, name, value) => {
    const res = await app().request("/health", { method, headers: { [name]: value } });
    expect(res.status).toBe(200);
  });
});

describe("the request the route sees still follows the client's connection", () => {
  it("a client gone in the middle of the body aborts the signal the route reads", async () => {
    const target = app();
    let seen: AbortSignal | undefined;
    target.post("/body-probe", async (c) => {
      seen = c.req.raw.signal;
      try {
        await c.req.text();
      } catch {
        // the read fails with the connection; what matters is the signal
      }
      return c.json({ aborted: c.req.raw.signal.aborted });
    });
    const client = new AbortController();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls < 3) {
          controller.enqueue(new Uint8Array(CHUNK));
          return;
        }
        client.abort(new Error("client gone"));
        controller.error(new Error("client gone"));
      },
    });
    const res = await target.request("/body-probe", {
      method: "POST",
      body: stream,
      duplex: "half",
      signal: client.signal,
    } as RequestInit);
    expect(await res.json()).toEqual({ aborted: true });
    expect(seen?.aborted).toBe(true);
  });
});
