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
  /^\[?::1\]?$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
];

function isPrivateHost(hostname: string): boolean {
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
