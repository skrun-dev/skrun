/**
 * Build the HTTP base URL for a runner on its private address.
 *
 * Lives in its own module rather than in the adapter so that both the adapter and
 * the pool can use it without importing each other — the adapter drives the pool,
 * so the dependency has to point one way.
 *
 * Fly's private addresses are IPv6, and `http://fdaa:...:9000` is not a valid URL:
 * the host part must be bracketed. IPv4 addresses pass through untouched.
 */
export function buildRunnerBaseUrl(privateIp: string, port: number): string {
  const isIpv6 = privateIp.includes(":");
  const host = isIpv6 ? `[${privateIp}]` : privateIp;
  return `http://${host}:${port}`;
}
