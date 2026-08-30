/**
 * SSRF-safe fetch for harness-side outbound requests (webhook delivery,
 * file-input URL fetch, remote-MCP connect).
 *
 * The host allowlist in `network.ts` is string-only; a hostname that *resolves*
 * to a private/internal IP (169.254.169.254, 127.0.0.1, ::1, ::, …) defeats it.
 * This guard closes that gap: it resolves the host, validates EVERY resolved IP
 * against `isPrivateHost`, and connects only to a validated IP — via an undici
 * dispatcher whose `connect.lookup` performs the resolution, so there is no
 * re-resolution window between check and connect (closes DNS rebinding). Each
 * redirect hop re-connects through the same dispatcher, so redirect targets are
 * validated too.
 *
 * We use undici's OWN `fetch`, not the Node global `fetch`: the global fetch
 * bundles a different undici version and rejects a dispatcher built from this
 * package ("invalid onRequestStart method"). undici's exported `fetch` honors
 * the `dispatcher` option from the same package version.
 */

import { lookup as dnsLookupCb } from "node:dns";
import {
  Agent,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
  fetch as undiciFetch,
} from "undici";
import { isPrivateHost } from "./network.js";

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolve a hostname to all of its addresses. Injectable for tests. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeFetchOptions {
  /** Abort the request after this many ms (default 30 000). */
  timeoutMs?: number;
  /** Follow redirects — each hop is re-validated by the dispatcher (default true). */
  followRedirects?: boolean;
  /**
   * Skip the private-IP block. Local webhook-testing opt-in ONLY
   * (`SKRUN_ALLOW_LOCAL_WEBHOOKS`); never enable for caller-controlled URLs.
   */
  allowPrivateHosts?: boolean;
  /** Injectable DNS resolver — the test seam (do NOT stub the global fetch). */
  resolver?: HostResolver;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const defaultResolver: HostResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookupCb(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family })));
    });
  });

/** Thrown when a request is blocked by the SSRF guard (bad scheme or private IP). */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

function guardedAgent(allowPrivateHosts: boolean, resolver: HostResolver): Agent {
  return new Agent({
    connect: {
      // undici invokes this with the node:dns.lookup signature and passes
      // { all: true } (verified). Resolve, validate EVERY address, and return
      // the validated set — undici then connects to one of these exact IPs.
      lookup(hostname, _options, callback) {
        resolver(hostname).then(
          (addresses) => {
            if (addresses.length === 0) {
              callback(new Error(`No DNS records for '${hostname}'`), []);
              return;
            }
            if (!allowPrivateHosts) {
              const blocked = addresses.find((a) => isPrivateHost(a.address));
              if (blocked) {
                callback(
                  new SsrfBlockedError(
                    `Blocked '${hostname}': resolves to the private/reserved address ${blocked.address}`,
                  ),
                  [],
                );
                return;
              }
            }
            callback(null, addresses);
          },
          (err: Error) => callback(err, []),
        );
      },
    },
  });
}

/**
 * SSRF-safe fetch. Rejects non-http(s) schemes and any request whose host
 * resolves — on any address, at the initial host or a redirect hop — to a
 * private/reserved IP. Returns an undici `Response`.
 */
export async function safeFetch(
  url: string | URL,
  init?: UndiciRequestInit,
  opts: SafeFetchOptions = {},
): Promise<UndiciResponse> {
  const parsed = typeof url === "string" ? new URL(url) : url;
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SsrfBlockedError(
      `Blocked '${parsed.href}': scheme '${parsed.protocol}' is not allowed (only http/https)`,
    );
  }
  const agent = guardedAgent(opts.allowPrivateHosts ?? false, opts.resolver ?? defaultResolver);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // timeoutMs === 0 means "no fetch-level timeout" — for long-lived streams (MCP
  // SSE) where a fixed abort would kill the connection; the caller owns timeouts.
  const signal = init?.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  try {
    return await undiciFetch(parsed, {
      ...init,
      dispatcher: agent,
      redirect: opts.followRedirects === false ? "manual" : "follow",
      signal,
    });
  } finally {
    void agent.close();
  }
}

/**
 * A `fetch`-shaped function backed by the SSRF guard, for injecting into clients
 * that accept a custom fetch (e.g. the MCP SDK transports). Imposes NO
 * fetch-level timeout — a fixed timeout would abort long-lived SSE streams; the
 * caller's protocol layer owns request timeouts. Each call validates the connect
 * IP through a fresh guarded dispatcher (graceful close keeps active streams open).
 */
export function createGuardedFetch(
  opts: { allowPrivateHosts?: boolean; resolver?: HostResolver } = {},
): (url: string | URL, init?: UndiciRequestInit) => Promise<UndiciResponse> {
  return (url, init) => safeFetch(url, init, { ...opts, timeoutMs: 0, followRedirects: true });
}
