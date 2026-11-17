/**
 * Network security — host allowlist enforcement.
 *
 * Modes (inferred from allowed_hosts):
 *   []              → all outbound blocked (safe default)
 *   ["host", ...]   → allowlist (only matching hosts)
 *   ["*"]           → unrestricted (all non-private hosts)
 *
 * Private, internal and reserved addresses are ALWAYS blocked (defense in
 * depth), even in unrestricted mode. The ranges are BLOCKED_RANGES, the list the
 * runner image also builds its shell check and its firewall rules from.
 */

import { BlockList, isIP } from "node:net";
import { BLOCKED_RANGES } from "./blocked-ranges.js";

/**
 * One BlockList per family, built once. Never one list for both: Node matches an
 * IPv4 address against an IPv6 rule through its mapped form, so `::ffff:0:0/96`
 * in a shared list would block every IPv4 address.
 */
function blockListFor(family: 4 | 6): BlockList {
  const list = new BlockList();
  for (const range of BLOCKED_RANGES) {
    const slash = range.lastIndexOf("/");
    const network = range.slice(0, slash);
    if (isIP(network) !== family) continue;
    list.addSubnet(network, Number(range.slice(slash + 1)), family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

const BLOCKED_V4 = blockListFor(4);
const BLOCKED_V6 = blockListFor(6);

/**
 * True if `hostname` is `localhost` or an address literal inside BLOCKED_RANGES.
 * A URL host's brackets are accepted (`[::1]`). Any other name is false: the
 * address it resolves to is checked where the connection is made
 * (`safe-fetch.ts`, which validates each DNS-resolved IP, and each address
 * literal it connects to, with this function).
 * Decimal/octal/hex IPv4 forms are not literals here — callers normalize the host
 * via `new URL(...).hostname` first, which rewrites them to dotted form.
 */
export function isPrivateHost(hostname: string): boolean {
  if (/^localhost$/i.test(hostname)) return true;
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const family = isIP(host);
  if (family === 4) return BLOCKED_V4.check(host, "ipv4");
  if (family === 6) return BLOCKED_V6.check(host, "ipv6");
  return false;
}

/**
 * The canonical form of an IPv6 literal — the one `URL.hostname` gives, bracketed,
 * zeros compressed, in lower case — or undefined when `text` is not one. Brackets
 * are optional on the way in. A literal the URL parser refuses (a zone,
 * `fe80::1%eth0`) is not one here: no URL can carry it.
 */
function canonicalIpv6(text: string): string | undefined {
  const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  if (isIP(bare) !== 6) return undefined;
  try {
    return new URL(`http://[${bare}]/`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Match a hostname against a pattern.
 * - Exact: "api.github.com" matches "api.github.com", in any case
 * - An IPv6 literal, on either side, is compared as the address it writes, with
 *   or without brackets: "2606:4700::1111", "[2606:4700::1111]" and
 *   "2606:4700:0:0:0:0:0:1111" are one address. A URL's host carries it
 *   bracketed; a list may name it bare, the form the cloud sandbox reads.
 * - Glob subdomain: "*.github.com" matches "api.github.com" but NOT "github.com",
 *   and never an IPv6 literal
 * - Full wildcard: "*" matches everything
 */
function matchHost(hostname: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p === "*") return true;
  const hostAddress = canonicalIpv6(hostname);
  if (p.startsWith("*.")) {
    if (hostAddress !== undefined) return false;
    const h = hostname.toLowerCase();
    const suffix = p.slice(1); // ".github.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  const patternAddress = canonicalIpv6(pattern);
  if (hostAddress !== undefined || patternAddress !== undefined) {
    return hostAddress === patternAddress;
  }
  return hostname.toLowerCase() === p;
}

/**
 * True if `hostname` matches at least one pattern of `allowedHosts` — the list
 * half of `isHostAllowed`, without its private-address rule. An empty list
 * matches nothing. The connection guard (`safe-fetch.ts`) applies it to every
 * connection it opens, redirect hops included, and checks addresses itself,
 * under its own operator opt-in.
 */
export function hostMatchesAllowlist(hostname: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((pattern) => matchHost(hostname, pattern));
}

/**
 * Check if a hostname is allowed by the allowlist.
 *
 * Rules:
 * 1. Private IPs always blocked (defense in depth)
 * 2. Empty allowedHosts → all blocked
 * 3. ["*"] in allowedHosts → unrestricted (non-private)
 * 4. Otherwise → hostname must match at least one pattern
 */
export function isHostAllowed(hostname: string, allowedHosts: string[]): boolean {
  // Private IPs always blocked
  if (isPrivateHost(hostname)) return false;

  // Empty = all blocked
  if (allowedHosts.length === 0) return false;

  // Check against patterns
  return hostMatchesAllowlist(hostname, allowedHosts);
}
