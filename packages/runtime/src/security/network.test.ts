import { describe, expect, it } from "vitest";
import { isHostAllowed } from "./network.js";

describe("isHostAllowed", () => {
  // VT-1: exact match
  it("allows exact host match", () => {
    expect(isHostAllowed("api.github.com", ["api.github.com"])).toBe(true);
  });

  // VT-2: exact reject
  it("rejects host not in allowlist", () => {
    expect(isHostAllowed("evil.com", ["api.github.com"])).toBe(false);
  });

  // VT-3: glob subdomain match
  it("allows glob subdomain match", () => {
    expect(isHostAllowed("api.github.com", ["*.github.com"])).toBe(true);
    expect(isHostAllowed("raw.github.com", ["*.github.com"])).toBe(true);
  });

  // VT-4: glob doesn't match bare domain
  it("rejects bare domain for glob pattern", () => {
    expect(isHostAllowed("github.com", ["*.github.com"])).toBe(false);
  });

  // VT-5: wildcard allows all
  it("allows all non-private hosts with wildcard", () => {
    expect(isHostAllowed("anything.com", ["*"])).toBe(true);
    expect(isHostAllowed("deep.nested.host.io", ["*"])).toBe(true);
  });

  // VT-6: empty blocks all
  it("blocks all hosts when allowlist is empty", () => {
    expect(isHostAllowed("api.github.com", [])).toBe(false);
    expect(isHostAllowed("google.com", [])).toBe(false);
  });

  // VT-7: private IP 127.x always blocked
  it("blocks 127.0.0.1 even with wildcard", () => {
    expect(isHostAllowed("127.0.0.1", ["*"])).toBe(false);
    expect(isHostAllowed("127.0.0.1", ["127.0.0.1"])).toBe(false);
  });

  // VT-8: private IP 10.x always blocked
  it("blocks 10.x.x.x even with wildcard", () => {
    expect(isHostAllowed("10.0.0.1", ["*"])).toBe(false);
    expect(isHostAllowed("10.255.0.1", ["*"])).toBe(false);
  });

  // VT-9: private IP 192.168.x always blocked
  it("blocks 192.168.x.x even with wildcard", () => {
    expect(isHostAllowed("192.168.1.1", ["*"])).toBe(false);
  });

  // VT-10: localhost always blocked
  it("blocks localhost even with wildcard", () => {
    expect(isHostAllowed("localhost", ["*"])).toBe(false);
    expect(isHostAllowed("localhost", ["localhost"])).toBe(false);
  });

  // Additional: 172.16-31.x blocked
  it("blocks 172.16-31.x.x", () => {
    expect(isHostAllowed("172.16.0.1", ["*"])).toBe(false);
    expect(isHostAllowed("172.31.255.1", ["*"])).toBe(false);
    // 172.32.x is NOT private
    expect(isHostAllowed("172.32.0.1", ["*"])).toBe(true);
  });

  // Additional: 169.254.x (link-local) blocked
  it("blocks 169.254.x.x", () => {
    expect(isHostAllowed("169.254.169.254", ["*"])).toBe(false);
  });

  // SEC-2026-003: CGNAT 100.64/10 (RFC 6598) blocked
  it("blocks CGNAT 100.64.0.0-100.127.255.255", () => {
    expect(isHostAllowed("100.64.0.1", ["*"])).toBe(false);
    expect(isHostAllowed("100.127.255.254", ["*"])).toBe(false);
    // boundaries: 100.63 and 100.128 are NOT CGNAT
    expect(isHostAllowed("100.63.255.1", ["*"])).toBe(true);
    expect(isHostAllowed("100.128.0.1", ["*"])).toBe(true);
  });

  // Additional: IPv6 loopback blocked
  it("blocks IPv6 loopback ::1", () => {
    expect(isHostAllowed("::1", ["*"])).toBe(false);
    expect(isHostAllowed("[::1]", ["*"])).toBe(false);
  });

  // VT-8 (SEC-006): IPv4-mapped IPv6 (::ffff:*) must not bypass the IPv4 allowlist
  it("VT-8: blocks IPv4-mapped IPv6 ::ffff:* (with and without brackets)", () => {
    // AWS metadata endpoint via IPv4-mapped — the headline exploit
    expect(isHostAllowed("::ffff:169.254.169.254", ["*"])).toBe(false);
    expect(isHostAllowed("[::ffff:169.254.169.254]", ["*"])).toBe(false);
    // Private IPv4 ranges via mapping
    expect(isHostAllowed("::ffff:10.0.0.1", ["*"])).toBe(false);
    expect(isHostAllowed("::ffff:127.0.0.1", ["*"])).toBe(false);
    expect(isHostAllowed("[::ffff:192.168.1.1]", ["*"])).toBe(false);
  });

  // VT-9 (SEC-006): link-local IPv6 fe80::/10 must be blocked
  it("VT-9: blocks link-local IPv6 fe80:* (with and without brackets)", () => {
    expect(isHostAllowed("fe80::1", ["*"])).toBe(false);
    expect(isHostAllowed("[fe80::1]", ["*"])).toBe(false);
    expect(isHostAllowed("fe80::abcd:1234", ["*"])).toBe(false);
    expect(isHostAllowed("FE80::1", ["*"])).toBe(false); // case-insensitive
  });

  // N-6 (SEC-2026-003): ULA fc00::/7 spans fc00:-fdff: — the full range must be
  // blocked, not just the fc00: prefix (with and without URL brackets).
  it("N-6: blocks ULA fc00::/7 across the full range", () => {
    expect(isHostAllowed("fc00::1", ["*"])).toBe(false);
    expect(isHostAllowed("fc01::1", ["*"])).toBe(false); // was uncaught by ^fc00:
    expect(isHostAllowed("fcff::1", ["*"])).toBe(false);
    expect(isHostAllowed("fd00::1", ["*"])).toBe(false);
    expect(isHostAllowed("fdff::abcd", ["*"])).toBe(false);
    expect(isHostAllowed("[fc01::1]", ["*"])).toBe(false); // bracketed URL host
    expect(isHostAllowed("[fd00::1]", ["*"])).toBe(false);
    expect(isHostAllowed("FC01::1", ["*"])).toBe(false); // case-insensitive
  });

  // Additional: case insensitive matching
  it("matches case-insensitively", () => {
    expect(isHostAllowed("API.GitHub.COM", ["api.github.com"])).toBe(true);
    expect(isHostAllowed("api.github.com", ["*.GitHub.COM"])).toBe(true);
  });

  // Additional: multiple patterns
  it("allows if any pattern matches", () => {
    expect(isHostAllowed("api.slack.com", ["*.github.com", "*.slack.com"])).toBe(true);
    expect(isHostAllowed("evil.com", ["*.github.com", "*.slack.com"])).toBe(false);
  });
});
