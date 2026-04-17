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

  // Additional: IPv6 loopback blocked
  it("blocks IPv6 loopback ::1", () => {
    expect(isHostAllowed("::1", ["*"])).toBe(false);
    expect(isHostAllowed("[::1]", ["*"])).toBe(false);
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
