/**
 * The address ranges an agent may never reach, on either runtime.
 *
 * ONE list, three consumers, so that they cannot disagree:
 *   - `isPrivateHost` (network.ts) classifies an address literal with it, in the
 *     harness and in the sandbox runner;
 *   - the runner image writes it to a file at build time, one range per line, and
 *     its shell helpers read that file: `is_private_ip` classifies each resolved
 *     address of an allowed host, and the egress setup DROPs every range before
 *     any ACCEPT of an agent's host.
 *
 * The image imports THIS module by its path under the installed runtime package,
 * so it must stay a plain data module: no import, no side effect.
 *
 * Source: the IANA IPv4 and IPv6 Special-Purpose Address Registries (last updated
 * 2025-10-09) — every block not globally reachable — plus the multicast blocks of
 * both address-space registries and the deprecated site-local IPv6 block. Where a
 * registry block holds a reachable sub-block (192.0.0.0/24, 2001::/23), the whole
 * block is listed: nothing an agent legitimately calls lives there. 64:ff9b::/96 is
 * reachable per the registry and listed anyway: it translates to ANY IPv4 address,
 * private ones included.
 *
 * Two blocks the registry does not list are listed for the same reason, each
 * holding an IPv4 address in its last 32 bits: ::/96, the deprecated
 * IPv4-compatible addresses (RFC 4291 §2.5.5.1), and ::ffff:0:0:0/96, SIIT's
 * IPv4-translated addresses (RFC 2765 §2.1, since obsoleted). A tunnel or a
 * translator can carry one to that IPv4 address, private ones included; nothing
 * an agent legitimately calls is written that way.
 */
export const BLOCKED_RANGES: readonly string[] = Object.freeze([
  // IPv4
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8", // private use
  "100.64.0.0/10", // shared address space (carrier-grade NAT)
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link local (cloud metadata endpoints live here)
  "172.16.0.0/12", // private use
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation
  "192.88.99.0/24", // deprecated 6to4 relay anycast
  "192.168.0.0/16", // private use
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation
  "203.0.113.0/24", // documentation
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, limited broadcast included
  // IPv6
  "::/128", // unspecified — connecting to it reaches the local host
  "::1/128", // loopback
  "::/96", // IPv4-compatible (deprecated) — holds the two above
  "::ffff:0:0/96", // IPv4-mapped
  "::ffff:0:0:0/96", // IPv4-translated (SIIT)
  "64:ff9b::/96", // IPv4/IPv6 translation
  "64:ff9b:1::/48", // local-use IPv4/IPv6 translation
  "100::/64", // discard-only
  "100:0:0:1::/64", // dummy prefix (RFC 9780)
  "2001::/23", // IETF protocol assignments
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4
  "3fff::/20", // documentation
  "5f00::/16", // segment routing
  "fc00::/7", // unique local
  "fe80::/10", // link local
  "fec0::/10", // site local (deprecated)
  "ff00::/8", // multicast
]);
