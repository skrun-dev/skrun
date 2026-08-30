#!/bin/bash
#
# DNS re-resolve loop — periodically updates the iptables egress allowlist
# to track short-TTL hostnames (CDN-fronted endpoints whose IPs rotate).
#
# Spawned as a background child of entrypoint.sh in `runner` mode before
# the capsh handoff. Runs as root throughout — capsh drops the user-code
# child to non-root with zero caps, but this loop must keep CAP_NET_ADMIN
# to call `iptables -A/-D`. tini reaps it on container SIGTERM.
#
# Inputs:
#   $1                            CSV of hostnames (same value as
#                                 SKRUN_ALLOWED_HOSTS passed to entrypoint).
#   SKRUN_DNS_RESOLVE_INTERVAL    sleep between cycles in seconds (default 30).
#
# State:
#   /run/skrun-allowed-ips        snapshot of "host|ip" pairs currently
#                                 ACCEPT'd (v4 + v6). Diffed each cycle to
#                                 compute ADD/DEL ops against ip(6)tables.

# `set -uo pipefail` deliberately WITHOUT `-e`: the ip6tables/iptables -D calls in
# the loop fail on already-removed rules and are handled with `|| log`; a global
# `-e` would abort the loop on the first such expected failure.
set -uo pipefail

# Shared egress helpers (is_private_ip) — kept in sync with network.ts.
source /usr/local/bin/net-lib.sh

HOSTS_CSV="${1:-}"
INTERVAL="${SKRUN_DNS_RESOLVE_INTERVAL:-30}"
STATE_FILE="/run/skrun-allowed-ips"
CHANNEL_DIR="/run/skrun-egress"
AWAIT_MODE=0
if [[ "$HOSTS_CSV" == "--await-assignment" ]]; then
  AWAIT_MODE=1
  HOSTS_CSV=""
fi

log() { echo "[skrun-dns-reresolve] $*" >&2; }

trap 'log "SIGTERM received — exiting"; exit 0' SIGTERM

# Initial state file. entrypoint.sh SEEDS this at boot with the exact host|ip
# pairs it ACCEPT'd, so we must NOT truncate it — read the seed and diff each
# cycle against it. If we truncated, the first cycle would re-add every boot rule
# as a duplicate, and a later -D for a rotated-away IP would remove only one of
# the two copies, leaving a ghost ACCEPT until restart (a private-IP-filter
# bypass). Create it empty only if the seed is somehow absent (e.g. entrypoint
# hit no allowed_hosts).
[[ -f "$STATE_FILE" ]] || : > "$STATE_FILE"

resolve_v4() { getent ahostsv4 "$1" 2>/dev/null | awk '{ print $1 }' | sort -u; }
resolve_v6() { getent ahostsv6 "$1" 2>/dev/null | awk '{ print $1 }' | sort -u; }

# Build the "host|ip" snapshot (v4 + v6) for the current SKRUN_ALLOWED_HOSTS
# CSV into the file path given as $1. The "|" delimiter survives the colons
# in IPv6 addresses. Private/link-local resolves are filtered out so they
# never enter the snapshot (and thus never get ACCEPT'd).
build_snapshot() {
  local out="$1"
  : > "$out"
  if [[ -z "$HOSTS_CSV" ]]; then
    return 0
  fi
  IFS=',' read -ra hosts <<< "$HOSTS_CSV"
  for host in "${hosts[@]}"; do
    host="${host// /}"
    [[ -z "$host" ]] && continue
    while IFS= read -r ip; do
      [[ -z "$ip" ]] && continue
      is_private_ip "$ip" && continue
      echo "$host|$ip" >> "$out"
    done < <(resolve_v4 "$host"; resolve_v6 "$host")
  done
}

# ---------------------------------------------------------------------------
# Assignment mode (pre-created machines only)
#
# A machine can be created and booted before it is assigned to a run, so that the
# image download and start-up happen in the background rather than on a caller's
# request. Such a machine does not know the agent's allowed hosts at boot, and by
# the time it does, the server process has already dropped to an unprivileged user
# with no capabilities and can no longer touch the firewall itself. This loop is
# already privileged and already manipulates exactly these rules, so it is what
# receives the list.
#
# The channel carries EXACTLY ONE message and is then destroyed, before any agent
# code can possibly run: assignment strictly precedes initialisation, which
# precedes the first tool call. That ordering — not a secret, not a file mode — is
# what puts the channel out of reach of the unprivileged code that comes later,
# which runs under the same user as the server process.
#
# Reads fd 3 (the request), answers on fd 4. Both were opened and handed over by
# the entrypoint before the privilege drop.
# ---------------------------------------------------------------------------

# Resolve one host list and ACCEPT each address, mirroring the boot-time path:
# same private/link-local refusal (so a rebinding answer can never open a route to
# the internal network), same state-file seeding so the periodic diff below starts
# from a truthful snapshot. Prints nothing; returns non-zero only on a bad list.
apply_assigned_hosts() {
  local csv="$1" host addr
  [[ -z "$csv" ]] && return 0   # an agent may legitimately declare no hosts
  IFS=',' read -ra hosts <<< "$csv"
  for host in "${hosts[@]}"; do
    host="${host// /}"
    [[ -z "$host" ]] && continue
    # Refuse anything that is not plausibly a hostname before it reaches getent.
    if [[ ! "$host" =~ ^[A-Za-z0-9._-]+$ ]]; then
      log "ASSIGN refusing malformed host: $host"
      return 1
    fi
    while IFS= read -r addr; do
      [[ -z "$addr" ]] && continue
      if is_private_ip "$addr"; then
        log "ASSIGN  $host → $addr — SKIP (private/link-local)"
        continue
      fi
      if [[ "$addr" == *:* ]]; then
        ip6tables -A OUTPUT -d "$addr" -j ACCEPT 2>/dev/null || log "  ip6tables -A failed for $addr"
      else
        iptables -A OUTPUT -d "$addr" -j ACCEPT 2>/dev/null || log "  iptables -A failed for $addr"
      fi
      echo "$host|$addr" >> "$STATE_FILE"
      log "ASSIGN  $host → $addr — ACCEPT"
    done < <(resolve_v4 "$host"; resolve_v6 "$host")
  done
  return 0
}

if [[ "$AWAIT_MODE" -eq 1 ]]; then
  log "awaiting assignment on the channel"
  if IFS= read -r assigned_csv <&3; then
    if apply_assigned_hosts "$assigned_csv"; then
      HOSTS_CSV="$assigned_csv"
      echo "OK" >&4
      log "assignment applied (${HOSTS_CSV:-no hosts}); channel closing"
    else
      # Fail closed: no rules installed, and the caller is told so. It will not
      # hand the machine a run — the machine is spent, not retried.
      echo "REFUSED" >&4
      log "assignment refused — no rules installed"
    fi
  else
    log "channel closed before an assignment arrived"
  fi
  # One message, then gone: unlink both ends and release the descriptors, so
  # nothing that starts later can find or use the channel.
  exec 3<&- 4<&-
  rm -rf "$CHANNEL_DIR" 2>/dev/null || log "WARNING: could not remove $CHANNEL_DIR"
fi

while sleep "$INTERVAL"; do
  if [[ -z "$HOSTS_CSV" ]]; then
    continue
  fi

  NEW_STATE=$(mktemp)
  build_snapshot "$NEW_STATE"

  # ADDED = in NEW_STATE but not in STATE_FILE
  # REMOVED = in STATE_FILE but not in NEW_STATE
  ADDED=$(comm -23 <(sort -u "$NEW_STATE") <(sort -u "$STATE_FILE") || true)
  REMOVED=$(comm -13 <(sort -u "$NEW_STATE") <(sort -u "$STATE_FILE") || true)

  while IFS='|' read -r host ip; do
    [[ -z "$ip" ]] && continue
    log "ADD  $host → $ip"
    if [[ "$ip" == *:* ]]; then
      ip6tables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || log "  ip6tables -A failed for $ip"
    else
      iptables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || log "  iptables -A failed for $ip"
    fi
  done <<< "$ADDED"

  while IFS='|' read -r host ip; do
    [[ -z "$ip" ]] && continue
    log "DEL  $host → $ip"
    if [[ "$ip" == *:* ]]; then
      ip6tables -D OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || log "  ip6tables -D failed for $ip (already removed?)"
    else
      iptables -D OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || log "  iptables -D failed for $ip (already removed?)"
    fi
  done <<< "$REMOVED"

  mv "$NEW_STATE" "$STATE_FILE"
done
