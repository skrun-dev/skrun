#!/bin/bash
# net-lib.sh — shared egress helpers for the runner sandbox, sourced by
# entrypoint.sh and dns-reresolve.sh.
#
# BLOCKED_RANGES_FILE : the address ranges an agent may never reach, one CIDR
# per line, IPv4 and IPv6. The image build writes it from the runtime's own list
# (BLOCKED_RANGES, packages/runtime/src/security/blocked-ranges.ts) — the list
# the harness's isPrivateHost reads too. Nobody edits it by hand: one list, every
# form of the rule produced from it.
BLOCKED_RANGES_FILE=/usr/local/share/skrun/blocked-ranges

# INFRA_SNAPSHOT_FILE : the infrastructure addresses the boot opened, one
# "host|address" line each, written by setup_iptables below; dns-reresolve.sh
# measures against it once a pre-created machine is assigned.
INFRA_SNAPSHOT_FILE=/run/skrun-infra-ips

# is_private_ip <addr> : returns 0 (true) when <addr> falls in a blocked range and
# must NEVER be ACCEPT'd for an agent's host — even when an allowed host resolves
# to it (DNS-rebinding defense). getent returns bare addresses (no brackets).
#
# Fail-closed: a missing or empty ranges file, an unreadable line, an address that
# does not parse, or python3 failing to run all answer "private". Only an address
# positively outside every range answers "not private" (python exit 1).
_IS_BLOCKED_PY='
import ipaddress, sys
try:
    addr = ipaddress.ip_address(sys.argv[1])
except ValueError:
    sys.exit(0)
ranges = 0
with open(sys.argv[2]) as listing:
    for line in listing:
        line = line.strip()
        if not line:
            continue
        try:
            net = ipaddress.ip_network(line)
        except ValueError:
            sys.exit(0)
        ranges += 1
        if addr.version == net.version and addr in net:
            sys.exit(0)
sys.exit(1 if ranges else 0)
'

is_private_ip() {
  local addr="$1" rc=0
  [[ -s "$BLOCKED_RANGES_FILE" ]] || return 0
  python3 -I -S -c "$_IS_BLOCKED_PY" "$addr" "$BLOCKED_RANGES_FILE" 2>/dev/null || rc=$?
  [[ "$rc" -ne 1 ]]
}

# The sourcing script normally brings its own `log`; this one only stands in when
# it does not (a test that sources this file to call setup_iptables).
if ! declare -F log >/dev/null; then
  log() { echo "[skrun-net] $*" >&2; }
fi

# setup_iptables : the sandbox's egress rules, installed by entrypoint.sh as root
# before the privilege drop. OUTPUT, in this order, on both families: loopback,
# established connections, ICMPv6, the runner's RPC replies to the harness, the nameservers, the
# infrastructure hosts, then a DROP for every blocked range, then the agent's hosts
# (SKRUN_ALLOWED_HOSTS) — named hosts, then `*`. The order is the security
# property: rules match first-hit, and everything added later is appended.
# Non-zero when the blocked ranges or the rules for `*` could not be installed.
setup_iptables() {
  local hosts_csv="${SKRUN_ALLOWED_HOSTS:-}"
  log "configuring iptables egress allowlist (mode=runner)"

  # Default-DROP on OUTPUT. INPUT stays default-ACCEPT — we trust the
  # Fly.io / Docker layer to firewall ingress.
  iptables -P OUTPUT DROP

  # Loopback (agent script may bind localhost — Playwright MCP debugger,
  # local Hono server, etc.)
  iptables -A OUTPUT -o lo -j ACCEPT

  # Established / related (return packets for the connections we ACCEPT
  # below). Without this rule, even ACCEPTed outbound connections never
  # see their response — kernel drops the reply.
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  # IPv6 egress: mirror the v4 policy. The runner sits on an IPv6 private
  # network — without this, outbound IPv6 is unrestricted and bypasses the
  # allowlist. INPUT stays default-ACCEPT (the inbound RPC is authenticated,
  # not network-gated). ESTABLISHED,RELATED keeps the RPC return path alive.
  ip6tables -P OUTPUT DROP
  ip6tables -A OUTPUT -o lo -j ACCEPT
  # ICMPv6 is MANDATORY for IPv6 to function: Neighbor Discovery resolves the
  # next-hop link-layer address for EVERY unicast, and Router Solicitation gets
  # the default route. Under -P OUTPUT DROP without this, the runner can't
  # ND-resolve any peer, so NO IPv6 packet is ever delivered — the RPC reply,
  # DNS, and allowed_hosts all silently fail. This is the classic ip6tables
  # egress-DROP mistake and the real cause of the early boot-probe failures.
  # ICMPv6 is not a data-egress channel, so this doesn't widen the box.
  ip6tables -A OUTPUT -p ipv6-icmp -j ACCEPT
  # Return path for the inbound RPC (harness → runner) + any egress we ACCEPT
  # below. Once ICMPv6/ND works, the kernel DOES track IPv6 connections, so
  # ESTABLISHED,RELATED is the primary carrier of the runner's RPC reply to the
  # harness. We ALSO add an explicit per-harness ACCEPT just below as
  # defense-in-depth — cheap insurance if a future kernel update regressed IPv6
  # conntrack, in which case ESTABLISHED alone would silently drop the reply.
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  # Explicit path for the runner's RPC replies to the harness (api-server),
  # defense-in-depth behind the ESTABLISHED,RELATED match above — and nothing
  # more. Two conditions: TCP leaving the port the runner listens on
  # (RUNNER_PORT, with the default the runner and the entrypoint read), and not
  # a lone SYN — a reply never starts a connection. The harness drives the
  # runner; nothing in the sandbox ever opens a connection to it. A rule on the
  # address alone would let the agent's code reach every port of the API server,
  # which listens on all its interfaces; a rule on the source port alone would
  # still let it through: the agent's code runs as the runner's user, so it can
  # stop the runner, take its port and open a new connection from there.
  # Omitted when RUNNER_HARNESS_6PN is unset (self-host / non-Fly).
  if [[ -n "${RUNNER_HARNESS_6PN:-}" ]]; then
    local rpc_port="${RUNNER_PORT:-9000}"
    log "  allowing the RPC replies (tcp from port ${rpc_port}, no new connection) to harness ${RUNNER_HARNESS_6PN}"
    ip6tables -A OUTPUT -d "${RUNNER_HARNESS_6PN}" -p tcp --sport "${rpc_port}" ! --syn -j ACCEPT ||
      log "  WARNING: the RPC reply rule to the harness was refused — replies ride on ESTABLISHED alone"
  fi

  # DNS: read nameservers from /etc/resolv.conf and ACCEPT UDP 53 to each.
  # Without this rule, getent / curl can't resolve the allowed hosts.
  while IFS= read -r ns; do
    if [[ -n "$ns" ]]; then
      log "  allowing DNS to $ns:53"
      # A v6 nameserver (Fly's internal resolver is IPv6) needs ip6tables;
      # a v4 one needs iptables. Detect by the presence of a colon.
      if [[ "$ns" == *:* ]]; then
        ip6tables -A OUTPUT -p udp -d "$ns" --dport 53 -j ACCEPT
        ip6tables -A OUTPUT -p tcp -d "$ns" --dport 53 -j ACCEPT
      else
        iptables -A OUTPUT -p udp -d "$ns" --dport 53 -j ACCEPT
        iptables -A OUTPUT -p tcp -d "$ns" --dport 53 -j ACCEPT
      fi
    fi
  done < <(awk '/^nameserver/ { print $2 }' /etc/resolv.conf)

  # Infra hosts (set by the harness): the object store (the bundle GET at /init —
  # outputs are harness-pulled via GET /outputs/file, never pushed by the runner,
  # so the outputs host is present here only as harmless dedup) and the install-
  # time package registries. These previously rode on the open IPv6 that the
  # ip6tables policy above now closes, so without an explicit rule every cloud run
  # fails at /init (bundle fetch). Resolved on BOTH families. They are harness-
  # controlled + trusted, so — unlike agent allowed_hosts — they are NOT run
  # through the private-IP filter (a self-host MinIO endpoint may be private), and
  # they sit BEFORE the blocked-range drops below for the same reason.
  local infra_pairs=""
  if [[ -n "${RUNNER_INFRA_HOSTS:-}" ]]; then
    log "resolving infra hosts: ${RUNNER_INFRA_HOSTS}"
    IFS=',' read -ra infra_hosts <<< "${RUNNER_INFRA_HOSTS}"
    for ihost in "${infra_hosts[@]}"; do
      ihost="${ihost// /}"
      [[ -z "$ihost" ]] && continue
      local ifound=0
      while IFS= read -r iaddr; do
        if [[ -n "$iaddr" ]]; then
          log "  infra $ihost → $iaddr — ACCEPT"
          iptables -A OUTPUT -d "$iaddr" -j ACCEPT
          infra_pairs+="$ihost|$iaddr"$'\n'
          ifound=1
        fi
      done < <(getent ahostsv4 "$ihost" | awk '{ print $1 }' | sort -u)
      while IFS= read -r iaddr; do
        if [[ -n "$iaddr" ]]; then
          log "  infra $ihost → $iaddr — ACCEPT (v6)"
          ip6tables -A OUTPUT -d "$iaddr" -j ACCEPT
          infra_pairs+="$ihost|$iaddr"$'\n'
          ifound=1
        fi
      done < <(getent ahostsv6 "$ihost" | awk '{ print $1 }' | sort -u)
      if [[ "$ifound" -eq 0 ]]; then
        log "  WARNING: infra host $ihost did not resolve — no rule added"
      fi
    done
  fi
  # The infrastructure addresses just opened, kept as "host|address" lines: they are
  # never re-resolved, and a pre-created machine, which may sleep long before its
  # assignment, measures there whether its infrastructure hosts still resolve within
  # them (dns-reresolve.sh). In /run, the directory only root may write in, through a
  # temporary file renamed into place: the agent's code, under another user, can
  # read it, never write, remove or replace it. A snapshot not written leaves that
  # measurement without a reference — it then says so — and fails nothing else.
  local infra_tmp=""
  if infra_tmp=$(mktemp "$INFRA_SNAPSHOT_FILE.XXXXXX") && printf '%s' "$infra_pairs" > "$infra_tmp" &&
    chmod 0644 "$infra_tmp" && mv -f "$infra_tmp" "$INFRA_SNAPSHOT_FILE"; then
    log "  infra addresses kept in $INFRA_SNAPSHOT_FILE"
  else
    [[ -n "$infra_tmp" ]] && rm -f "$infra_tmp"
    log "  WARNING: could not keep the infra addresses in $INFRA_SNAPSHOT_FILE"
  fi

  # The blocked ranges, DROPped on both families — AFTER everything above (the
  # nameservers, the harness and ICMPv6 live in private or link-local ranges on
  # Fly: a drop placed before them would cut IPv6 whole, silently) and BEFORE
  # every agent host below. Whatever is appended later — an agent host at
  # assignment, a re-resolved address — lands after these drops, so a blocked
  # address is refused by the kernel even if an ACCEPT for it follows. A boot
  # that cannot install them fails: without them, `*` would open everything.
  if ! apply_blocked_ranges; then
    log "ERROR: the blocked address ranges could not be installed"
    return 1
  fi

  # Seed the dns-reresolve state file with the exact host|ip pairs we ACCEPT at
  # boot below. dns-reresolve.sh reads this snapshot (it does NOT truncate it) so
  # its first diff is empty; otherwise the first cycle re-adds every boot rule as
  # a duplicate, and a later -D for a rotated-away IP removes only one copy,
  # leaving a ghost ACCEPT until restart. Only agent allowed_hosts are tracked
  # (infra hosts are not re-resolved, and `*` has no address to track). Truncate
  # once here; append after each ACCEPT below.
  local state_file="/run/skrun-allowed-ips"
  : > "$state_file" || log "  WARNING: cannot init dns-reresolve state file $state_file"

  # Resolve each allowed host to its current IPv4(s) and ACCEPT outbound
  # connections to each. getent supports CSV via xargs splitting.
  local open_egress=0
  if [[ -n "$hosts_csv" ]]; then
    log "resolving allowed hosts: $hosts_csv"
    IFS=',' read -ra hosts <<< "$hosts_csv"
    for host in "${hosts[@]}"; do
      host="${host// /}"
      [[ -z "$host" ]] && continue
      # `*` resolves nothing: it opens every address outside the blocked ranges,
      # after the named hosts (below the loop). Any other pattern is refused
      # before a machine is ever created; should one arrive anyway, it gets no rule.
      if [[ "$host" == "*" ]]; then
        open_egress=1
        continue
      fi
      if [[ "$host" == *"*"* ]]; then
        log "  $host — pattern not supported in the sandbox, no rule added"
        continue
      fi
      # getent prints "IP HOSTNAME ALIASES..." one line per address.
      # We take the first column. May return 0 results — log and continue.
      local found=0
      # getent ahostsv4 yields IPv4 only (AF_INET), deterministic + symmetric
      # with the ahostsv6 arm below. (`getent hosts` is resolver-order-dependent
      # and can return AAAA-first — or v6-only — leaving no v4 rule; the dev-image
      # cloud-verify caught exactly this on a runner where `getent hosts
      # example.com` returned its AAAA.)
      while IFS= read -r addr; do
        if [[ -n "$addr" ]]; then
          # Never ACCEPT a resolved private/link-local IP, even for an
          # operator-declared allowed_host (DNS-rebinding defense).
          if is_private_ip "$addr"; then
            log "  $host → $addr — SKIP (private/link-local)"
            continue
          fi
          log "  $host → $addr — ACCEPT"
          iptables -A OUTPUT -d "$addr" -j ACCEPT
          echo "$host|$addr" >> "$state_file" || log "  WARNING: state-file seed failed for $host|$addr"
          found=1
        fi
      done < <(getent ahostsv4 "$host" | awk '{ print $1 }' | sort -u)
      # IPv6 (AAAA): resolve v6 addresses and ACCEPT each via ip6tables, same
      # private-IP filter. getent ahostsv6 yields v6 only (multiple socktype
      # lines per address — sort -u dedups).
      while IFS= read -r addr6; do
        if [[ -n "$addr6" ]]; then
          if is_private_ip "$addr6"; then
            log "  $host → $addr6 — SKIP (private/link-local)"
            continue
          fi
          log "  $host → $addr6 — ACCEPT (v6)"
          ip6tables -A OUTPUT -d "$addr6" -j ACCEPT
          echo "$host|$addr6" >> "$state_file" || log "  WARNING: state-file seed failed for $host|$addr6"
          found=1
        fi
      done < <(getent ahostsv6 "$host" | awk '{ print $1 }' | sort -u)
      if [[ "$found" -eq 0 ]]; then
        log "  WARNING: $host did not resolve — no rule added"
      fi
    done
  else
    log "SKRUN_ALLOWED_HOSTS empty — egress restricted to loopback + DNS only"
  fi

  if [[ "$open_egress" -eq 1 ]] && ! allow_open_egress; then
    log "ERROR: the rules for '*' could not be installed"
    return 1
  fi

  log "iptables egress allowlist configured"
}

# apply_blocked_ranges : DROP every range of BLOCKED_RANGES_FILE, IPv4 ranges with
# iptables and IPv6 ones with ip6tables, appended to OUTPUT. Non-zero when the file
# is missing or empty, or when a rule is refused — the caller must not go on to
# accept anything for the agent.
apply_blocked_ranges() {
  local range count=0
  [[ -s "$BLOCKED_RANGES_FILE" ]] || { log "  ERROR: no blocked-ranges file at $BLOCKED_RANGES_FILE"; return 1; }
  while IFS= read -r range; do
    [[ -z "$range" ]] && continue
    if [[ "$range" == *:* ]]; then
      ip6tables -A OUTPUT -d "$range" -j DROP || { log "  ERROR: ip6tables refused DROP $range"; return 1; }
    else
      iptables -A OUTPUT -d "$range" -j DROP || { log "  ERROR: iptables refused DROP $range"; return 1; }
    fi
    count=$((count + 1))
  done < "$BLOCKED_RANGES_FILE"
  [[ "$count" -gt 0 ]] || { log "  ERROR: the blocked-ranges file lists no range"; return 1; }
  log "  blocked ranges: $count DROP rules installed (v4 + v6)"
}

# blocked_ranges_in_place : 0 when every range of the file has its DROP rule in
# OUTPUT. What stands between `*` and the internal network, checked again before
# `*` is applied at assignment, long after the boot installed it.
blocked_ranges_in_place() {
  local range
  [[ -s "$BLOCKED_RANGES_FILE" ]] || return 1
  while IFS= read -r range; do
    [[ -z "$range" ]] && continue
    if [[ "$range" == *:* ]]; then
      ip6tables -C OUTPUT -d "$range" -j DROP 2>/dev/null || return 1
    else
      iptables -C OUTPUT -d "$range" -j DROP 2>/dev/null || return 1
    fi
  done < "$BLOCKED_RANGES_FILE"
}

# allow_open_egress : what `*` means in the sandbox, on both families, appended
# after the blocked-range drops: every other address, TCP port 25 excepted —
# refused with a reset, so a mail relay attempt fails at once instead of hanging.
# A host the agent names keeps every port: its ACCEPT is placed before these.
allow_open_egress() {
  iptables -A OUTPUT -p tcp --dport 25 -j REJECT --reject-with tcp-reset || return 1
  ip6tables -A OUTPUT -p tcp --dport 25 -j REJECT --reject-with tcp-reset || return 1
  iptables -A OUTPUT -j ACCEPT || return 1
  ip6tables -A OUTPUT -j ACCEPT || return 1
  log "  '*': every address outside the blocked ranges accepted, TCP/25 refused (v4 + v6)"
}
