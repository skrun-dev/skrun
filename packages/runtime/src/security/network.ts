/**
 * Network security — host allowlist enforcement.
 *
 * Modes (inferred from allowed_hosts):
 *   []              → all outbound blocked (safe default)
 *   ["host", ...]   → allowlist (only matching hosts)
 *   ["*"]           → unrestricted (all non-private hosts)
 *
 * Private/internal IPs are ALWAYS blocked (defense in depth), even in unrestricted mode.
 */

const PRIVATE_IP_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  // SEC-2026-003: CGNAT shared address space (RFC 6598) — 100.64.0.0–100.127.255.255
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^\[?::1\]?$/,
  // IPv6 unspecified address (::) — resolving to :: reaches the local host.
  /^\[?::\]?$/,
  /^0:0:0:0:0:0:0:0$/,
  /^\[?::ffff:/i,
  /^fe80:/i,
  /^\[fe80:/i,
  // SEC-2026-003 / N-6: ULA fc00::/7 spans fc00:–fdff: — match the full /7
  // (fc00: alone was a too-narrow prefix). Bracketed forms mirror the fe80
  // variants for URL hosts; the shell layer (net-lib.sh) sees bare getent IPs
  // so it needs no bracket form.
  /^fc[0-9a-f]{2}:/i,
  /^\[fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^\[fd[0-9a-f]{2}:/i,
];

/**
 * True if `hostname` is a private / reserved / loopback address literal.
 * Exported for the connect-time guard (`safe-fetch.ts`), which validates each
 * DNS-resolved IP with it. Correct handling of decimal/octal/hex IPv4 literals
 * assumes callers normalize the host via `new URL(...).hostname` first.
 */
export function isPrivateHost(hostname: string): boolean {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname));
}

/**
 * Match a hostname against a pattern.
 * - Exact: "api.github.com" matches "api.github.com"
 * - Glob subdomain: "*.github.com" matches "api.github.com" but NOT "github.com"
 * - Full wildcard: "*" matches everything
 */
function matchHost(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".github.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
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
  return allowedHosts.some((pattern) => matchHost(hostname, pattern));
}
