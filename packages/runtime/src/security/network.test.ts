import { BlockList, isIP } from "node:net";
import { describe, expect, it } from "vitest";
import { BLOCKED_RANGES } from "./blocked-ranges.js";
import { hostMatchesAllowlist, isHostAllowed, isPrivateHost } from "./network.js";

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

// An IPv6 literal reaches the comparison in two forms: bracketed, as
// `URL.hostname` gives it (an MCP server's URL, a connection the guard checks),
// and bare, as the list may be written — and as the cloud route passes it to the
// sandbox, whose firewall reads it so. Both sides are one address however each
// is written.
describe("isHostAllowed — an IPv6 literal matches its address however it is written", () => {
  const ADDRESS_IN_URL_FORM = "[2606:4700::1111]";

  it.each([
    "2606:4700::1111",
    "[2606:4700::1111]",
    "2606:4700:0:0:0:0:0:1111",
    "[2606:4700:0:0:0:0:0:1111]",
    "2606:4700:0000:0000::1111",
  ])("the list entry %s matches the address, bracketed or bare", (entry) => {
    expect(isHostAllowed(ADDRESS_IN_URL_FORM, [entry])).toBe(true);
    expect(isHostAllowed("2606:4700::1111", [entry])).toBe(true);
  });

  it("compares the hex digits of an address whatever their case", () => {
    expect(isHostAllowed("[2606:4700::abcd]", ["2606:4700::ABCD"])).toBe(true);
    expect(isHostAllowed("[2606:4700::ABCD]", ["[2606:4700::abcd]"])).toBe(true);
  });

  it("matches another address on neither side", () => {
    for (const entry of ["2606:4700::1112", "[2606:4700::1112]", "2606:4700::111"]) {
      expect(isHostAllowed(ADDRESS_IN_URL_FORM, [entry])).toBe(false);
    }
    // An IPv4 entry is not the IPv6 form of its address.
    expect(hostMatchesAllowlist("[::ffff:101:101]", ["1.1.1.1"])).toBe(false);
  });

  it("never lets a subdomain pattern match an IPv6 literal, and lets * match it", () => {
    expect(hostMatchesAllowlist("2001:db8::1.2.3.4", ["*.2.3.4"])).toBe(false);
    expect(hostMatchesAllowlist("[2001:db8::1.2.3.4]", ["*.2.3.4"])).toBe(false);
    expect(hostMatchesAllowlist(ADDRESS_IN_URL_FORM, ["*.1111"])).toBe(false);
    expect(isHostAllowed(ADDRESS_IN_URL_FORM, ["*"])).toBe(true);
  });

  it("compares as text what is not an IPv6 literal, and never matches it to an address", () => {
    expect(hostMatchesAllowlist("[zz]", ["[zz]"])).toBe(true);
    expect(hostMatchesAllowlist(ADDRESS_IN_URL_FORM, ["[zz]"])).toBe(false);
    expect(hostMatchesAllowlist("[zz]", ["2606:4700::1111"])).toBe(false);
    // A zone is not part of an address a URL can carry.
    expect(hostMatchesAllowlist("[fe80::1]", ["fe80::1%eth0"])).toBe(false);
  });

  it("keeps the private-address rule ahead of the list, whatever the spelling", () => {
    for (const entry of ["::1", "[::1]", "0:0:0:0:0:0:0:1"]) {
      expect(isHostAllowed("[::1]", [entry])).toBe(false);
      expect(hostMatchesAllowlist("[::1]", [entry])).toBe(true);
    }
  });
});

// The witnesses of the blocked ranges. The runner image classifies addresses from
// the same BLOCKED_RANGES list; its own check replays witnesses of this kind there.
const BLOCKED_WITNESSES = [
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.0.0.8",
  "192.0.2.1",
  "192.88.99.1",
  "192.168.1.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  "::",
  "0:0:0:0:0:0:0:0",
  "::1",
  "::7f00:1",
  "::ffff:10.0.0.1",
  "::ffff:8.8.8.8",
  "::ffff:0:7f00:1",
  "64:ff9b::a00:1",
  "64:ff9b:1::1",
  "100::1",
  "100:0:0:1::5",
  "2001::1",
  "2001:db8::1",
  "2002::1",
  "3fff::1",
  "5f00::1",
  "fc00::1",
  "fd00::1",
  "fe80::1",
  "fec0::1",
  "ff02::1",
];

const PUBLIC_WITNESSES = [
  "8.8.8.8",
  "1.1.1.1",
  "93.184.216.34",
  "172.32.0.1",
  "100.128.0.1",
  "198.20.0.1",
  "2001:4860:4860::8888",
  "2606:4700:4700::1111",
  "2001:200::1",
];

describe("isPrivateHost — blocked ranges", () => {
  it.each(BLOCKED_WITNESSES)("blocks %s", (address) => {
    expect(isPrivateHost(address)).toBe(true);
    expect(isHostAllowed(address, ["*"])).toBe(false);
    // A URL host carries an IPv6 literal in brackets.
    if (address.includes(":")) expect(isPrivateHost(`[${address}]`)).toBe(true);
  });

  it.each(PUBLIC_WITNESSES)("lets the public address %s through", (address) => {
    expect(isPrivateHost(address)).toBe(false);
    expect(isHostAllowed(address, ["*"])).toBe(true);
  });

  it("gives every blocked range at least one witness", () => {
    const unwitnessed = BLOCKED_RANGES.filter((range) => {
      const slash = range.lastIndexOf("/");
      const network = range.slice(0, slash);
      const family = isIP(network) === 4 ? "ipv4" : "ipv6";
      const list = new BlockList();
      list.addSubnet(network, Number(range.slice(slash + 1)), family);
      return !BLOCKED_WITNESSES.some((w) => isIP(w) === isIP(network) && list.check(w, family));
    });
    expect(unwitnessed).toEqual([]);
  });

  it("names localhost, and nothing else by name", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("LOCALHOST")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("10.example.com")).toBe(false);
  });

  it("parses every range of the list", () => {
    for (const range of BLOCKED_RANGES) {
      expect(range).toMatch(/^[0-9a-f.:]+\/\d{1,3}$/);
      expect(isIP(range.slice(0, range.lastIndexOf("/")))).not.toBe(0);
    }
  });

  // The image reads the same list with Python's `ipaddress`, which refuses a
  // network written with host bits; its check then fails closed and calls every
  // address private. Node's BlockList accepts the same text. So the list holds
  // networks only, written as their network address.
  it.each([
    ["10.0.0.0/8", true],
    ["192.0.0.8/29", true],
    ["192.0.0.9/29", false],
    ["10.0.0.0/33", false],
    ["10.0.0.0/08", false],
    ["fc00::/7", true],
    ["fd00::/7", false],
    ["::/128", true],
    ["::ffff:0:0/96", true],
    ["::ffff:0:1/96", false],
    ["::/96", true],
    ["::ffff:0:0:0/96", true],
    ["::ffff:0:0:1/96", false],
    ["100:0:0:1::/64", true],
    ["fe80::/129", false],
  ])("the form check judges %s canonical: %s", (range, expected) => {
    expect(isCanonicalRange(range)).toBe(expected);
  });

  it("writes every range as its network address, with a prefix its family allows", () => {
    expect(BLOCKED_RANGES.filter((range) => !isCanonicalRange(range))).toEqual([]);
  });
});

/** An address literal as a number, with its width in bits; null when it is not one. */
function addressBits(text: string): { value: bigint; bits: number } | null {
  const family = isIP(text);
  if (family === 4) {
    const value = text.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
    return { value, bits: 32 };
  }
  if (family !== 6) return null;
  // A dotted IPv4 tail (::ffff:1.2.3.4) stands for the last two groups.
  let hex = text;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail?.[1]) {
    const v4 = addressBits(tail[1])?.value ?? 0n;
    hex = `${text.slice(0, -tail[1].length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const groupsOf = (part: string) => (part === "" ? [] : part.split(":"));
  const [head = "", rest = ""] = hex.split("::");
  const groups = hex.includes("::")
    ? [
        ...groupsOf(head),
        ...Array<string>(8 - groupsOf(head).length - groupsOf(rest).length).fill("0"),
        ...groupsOf(rest),
      ]
    : groupsOf(head);
  const value = groups.reduce(
    (acc, group) => (acc << 16n) | BigInt(Number.parseInt(group, 16)),
    0n,
  );
  return { value, bits: 128 };
}

/** Whether `range` is a network written as such: a prefix its family allows, no host bit set. */
function isCanonicalRange(range: string): boolean {
  const slash = range.lastIndexOf("/");
  const prefixText = range.slice(slash + 1);
  if (slash < 0 || !/^(0|[1-9]\d{0,2})$/.test(prefixText)) return false;
  const address = addressBits(range.slice(0, slash));
  const prefix = Number(prefixText);
  if (address === null || prefix > address.bits) return false;
  const hostMask = (1n << BigInt(address.bits - prefix)) - 1n;
  return (address.value & hostMask) === 0n;
}
