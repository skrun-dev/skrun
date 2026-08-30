#!/bin/bash
# net-lib.sh — shared egress helpers for the runner sandbox.
#
# is_private_ip <addr> : returns 0 (true) when <addr> is a private, internal,
# loopback, link-local, or CGNAT address that must NEVER be ACCEPT'd in the
# egress allowlist — even when an operator-declared allowed_host resolves to
# it (DNS-rebinding defense). Mirrors the PRIVATE_IP_PATTERNS list in
# packages/runtime/src/security/network.ts EXACTLY — keep the two in sync.
#
# getent returns bare IP addresses (no brackets), so no bracket handling.

is_private_ip() {
  local addr="$1"
  shopt -s nocasematch
  local rc=1
  if [[ "$addr" =~ ^127\. ]] ||
    [[ "$addr" =~ ^10\. ]] ||
    [[ "$addr" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]] ||
    [[ "$addr" =~ ^192\.168\. ]] ||
    [[ "$addr" =~ ^169\.254\. ]] ||
    [[ "$addr" =~ ^0\. ]] ||
    [[ "$addr" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]] ||
    [[ "$addr" =~ ^::1$ ]] ||
    [[ "$addr" =~ ^::ffff: ]] ||
    [[ "$addr" =~ ^fe80: ]] ||
    [[ "$addr" =~ ^fc[0-9a-f]{2}: ]] ||
    [[ "$addr" =~ ^fd[0-9a-f]{2}: ]]; then
    rc=0
  fi
  shopt -u nocasematch
  return $rc
}
