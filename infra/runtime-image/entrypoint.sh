#!/bin/bash
#
# skrun-runtime entrypoint — dispatcher between `runner` (cloud sandbox)
# and `api-server` (self-host single-tenant) modes.
#
# Runner mode (cloud): configures iptables egress allowlist
# synchronously from SKRUN_ALLOWED_HOSTS before any user code can reach
# the network. The capsh handoff (zero-cap drop + non-root UID switch)
# is added in a follow-up; this file leaves the runner process running
# with the NET_ADMIN capability granted by docker-compose. NOT the final
# hardened state — the capsh handoff closes that gap.
#
# Api-server mode (self-host): skips iptables entirely (operator trusts
# their own agents, single-tenant), drops to the skrun-runner user via
# the docker-compose `user: '1000:1000'` directive set on the api service
# (no `su` needed at the entrypoint level).
#
# Inputs:
#   SKRUN_CONTAINER_MODE      runner | api-server (default: api-server)
#   SKRUN_ALLOWED_HOSTS       CSV of hosts the agent is allowed to reach
#                             (runner mode only). Resolved via getent at
#                             boot and ACCEPT'd by ip. Empty list = no
#                             egress except loopback + DNS.
#
# Exit codes:
#   0   success — exec'd into runner-start.sh or api-server-start.sh
#   1   unknown mode
#   2   iptables setup failed (missing NET_ADMIN cap?)
#   3   assignment channel could not be created (pre-created machines only)

set -euo pipefail

# Shared egress helpers (is_private_ip) — kept in sync with
# packages/runtime/src/security/network.ts. Defines the function; the egress
# allowlist (runner mode) uses it to refuse a resolved private/link-local IP.
source /usr/local/bin/net-lib.sh

MODE="${SKRUN_CONTAINER_MODE:-api-server}"

log() {
  echo "[skrun-entrypoint] $*" >&2
}

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

  # Explicit RPC return path to the harness (api-server), defense-in-depth behind
  # the ESTABLISHED,RELATED match above. The harness's own 6PN is the trusted
  # control plane (it already drives the runner), NOT a cross-tenant peer, so this
  # does not widen the sandbox — sibling runners / Fly internals stay DROPped.
  # Omitted when RUNNER_HARNESS_6PN is unset (self-host / non-Fly).
  if [[ -n "${RUNNER_HARNESS_6PN:-}" ]]; then
    log "  allowing RPC return path to harness ${RUNNER_HARNESS_6PN}"
    ip6tables -A OUTPUT -d "${RUNNER_HARNESS_6PN}" -j ACCEPT
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

  # Seed the dns-reresolve state file with the exact host|ip pairs we ACCEPT at
  # boot below. dns-reresolve.sh reads this snapshot (it does NOT truncate it) so
  # its first diff is empty; otherwise the first cycle re-adds every boot rule as
  # a duplicate, and a later -D for a rotated-away IP removes only one copy,
  # leaving a ghost ACCEPT until restart. Only agent allowed_hosts are tracked
  # (infra hosts are not re-resolved). Truncate once here; append after each
  # ACCEPT below.
  local state_file="/run/skrun-allowed-ips"
  : > "$state_file" || log "  WARNING: cannot init dns-reresolve state file $state_file"

  # Resolve each allowed host to its current IPv4(s) and ACCEPT outbound
  # connections to each. getent supports CSV via xargs splitting.
  if [[ -n "$hosts_csv" ]]; then
    log "resolving allowed hosts: $hosts_csv"
    IFS=',' read -ra hosts <<< "$hosts_csv"
    for host in "${hosts[@]}"; do
      host="${host// /}"
      [[ -z "$host" ]] && continue
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

  # Infra hosts (set by the harness): the object store (the bundle GET at /init —
  # outputs are harness-pulled via GET /outputs/file, never pushed by the runner,
  # so the outputs host is present here only as harmless dedup) and the install-
  # time package registries. These previously rode on the open IPv6 that the
  # ip6tables policy above now closes, so without an explicit rule every cloud run
  # fails at /init (bundle fetch). Resolved on BOTH families. They are harness-
  # controlled + trusted, so — unlike agent allowed_hosts — they are NOT run
  # through the private-IP filter (a self-host MinIO endpoint may be private).
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
          ifound=1
        fi
      done < <(getent ahostsv4 "$ihost" | awk '{ print $1 }' | sort -u)
      while IFS= read -r iaddr; do
        if [[ -n "$iaddr" ]]; then
          log "  infra $ihost → $iaddr — ACCEPT (v6)"
          ip6tables -A OUTPUT -d "$iaddr" -j ACCEPT
          ifound=1
        fi
      done < <(getent ahostsv6 "$ihost" | awk '{ print $1 }' | sort -u)
      if [[ "$ifound" -eq 0 ]]; then
        log "  WARNING: infra host $ihost did not resolve — no rule added"
      fi
    done
  fi

  log "iptables egress allowlist configured"
}

case "$MODE" in
  runner)
    # Pre-created machines: a machine can be created and booted BEFORE it is
    # assigned to a run, so that the image download and this start-up are paid in
    # the background instead of on the caller's request. Such a machine knows the
    # agent's allowed hosts only later, at assignment time.
    #
    # The posture is derived from RUNNER_CLAIM_TOKEN's presence rather than a
    # separate flag, and that is deliberate: a flag could be set without the
    # credential, producing a machine that waits to be assigned while holding
    # nothing that gates assignment. Deriving it makes that state unrepresentable.
    #
    # Everything below is UNCHANGED for a machine created for a single run.
    if [[ -n "${RUNNER_CLAIM_TOKEN:-}" ]]; then
      AWAITING_ASSIGNMENT=1
      log "pre-created machine — will receive its agent host list at assignment"
    else
      AWAITING_ASSIGNMENT=0
    fi

    # Cold-start telemetry (observability): time the egress-allowlist setup so
    # the runner can report it as a startup phase. Timing ONLY — setup_iptables
    # is unchanged. Written to a world-readable marker (root writes it here; the
    # runner reads it as uid 1000 after the capsh handoff below). Never fail the
    # boot on a timing/marker error.
    #
    # On a pre-created machine SKRUN_ALLOWED_HOSTS is simply absent, so the loop
    # over agent hosts is skipped and everything that does NOT depend on the agent
    # is still installed now: the default-DROP policy, loopback, established
    # connections, ICMPv6, the nameservers, the infrastructure hosts and the
    # control-plane return path. Those are the same for every run, so paying for
    # them here costs the caller nothing — and the machine is never open in the
    # meantime.
    egress_start_ms=$(date +%s%3N)
    if ! setup_iptables; then
      log "ERROR: iptables setup failed (missing NET_ADMIN capability?)"
      exit 2
    fi
    egress_ms=$(( $(date +%s%3N) - egress_start_ms ))
    boot_marker="/tmp/skrun-boot.json"
    if printf '{"egress_ms":%s}\n' "$egress_ms" > "$boot_marker" 2>/dev/null; then
      chmod a+r "$boot_marker" 2>/dev/null || true
      log "egress setup took ${egress_ms}ms (boot marker written)"
    else
      log "  WARNING: could not write boot marker $boot_marker"
    fi

    # DIAGNOSTIC (opt-in via RUNNER_EGRESS_DEBUG): ~8s after boot — once the
    # harness boot-probe has hit — dump the live ip6tables OUTPUT ruleset WITH
    # packet counters so a cloud-verify can see which rule caught the RPC reply
    # (ESTABLISHED at 0 pkts ⇒ conntrack isn't firing; the harness rule with pkts
    # ⇒ it carries the reply). Off by default → zero noise on a normal run.
    if [[ -n "${RUNNER_EGRESS_DEBUG:-}" ]]; then
      (
        sleep 8
        log "DIAG ip6tables OUTPUT -nv (post-boot-probe):"
        { ip6tables -L OUTPUT -n -v 2>&1 || true; } | while IFS= read -r dl; do log "  DIAG6| $dl"; done
        log "DIAG conntrack count=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo NA) mods=$(grep -c conntrack /proc/modules 2>/dev/null || echo NA)"
      ) &
    fi

    # Defence in depth on a pre-created machine: until it is assigned, its RPC port
    # is guarded only by the assignment credential. Restrict who may even reach that
    # port to the control plane's own address, so reaching it requires being on the
    # right host AND holding the credential.
    #
    # Scoped to the RPC port rather than a blanket INPUT policy of DROP. The asset
    # is the RPC surface; dropping all inbound traffic would also cut the platform's
    # own management access to the machine — the operator console we rely on to
    # inspect a runner, and which by definition already has full authority over it.
    # Blocking the platform that owns the machine buys nothing and costs the only
    # way in when something goes wrong.
    #
    # Skipped when the control-plane address is unknown (self-host / non-Fly): an
    # unreachable machine is worse than one relying on the credential alone.
    if [[ "${AWAITING_ASSIGNMENT:-0}" -eq 1 && -n "${RUNNER_HARNESS_6PN:-}" ]]; then
      rpc_port="${RUNNER_PORT:-9000}"
      log "restricting inbound RPC on port ${rpc_port} to ${RUNNER_HARNESS_6PN}"
      # Loopback FIRST — rules match in order. Without this the drop below would
      # also refuse a health probe issued from inside the machine, which is how
      # both the image smoke and any hands-on inspection check the server is up.
      ip6tables -A INPUT -i lo -j ACCEPT || log "  WARNING: could not allow inbound loopback (v6)"
      iptables -A INPUT -i lo -j ACCEPT || log "  WARNING: could not allow inbound loopback (v4)"
      ip6tables -A INPUT -p tcp --dport "$rpc_port" -s "${RUNNER_HARNESS_6PN}" -j ACCEPT \
        || log "  WARNING: could not add the inbound RPC allow rule"
      ip6tables -A INPUT -p tcp --dport "$rpc_port" -j DROP \
        || log "  WARNING: could not add the inbound RPC drop rule"
      iptables -A INPUT -p tcp --dport "$rpc_port" -j DROP \
        || log "  WARNING: could not add the inbound RPC drop rule (v4)"
    fi

    # On a pre-created machine, build the one-message channel the runner uses to
    # hand its agent host list to the privileged loop below. Both ends live in a
    # directory only root can enter: the runner never opens them by path (it gets
    # the descriptors by inheritance across the privilege drop), so no one else
    # needs to. That closes the path-based route for the unprivileged code that
    # runs later, on top of the fact that descriptors are not passed to it.
    #
    # Both FIFOs are opened read-write on purpose. Opening a FIFO one way blocks
    # until the other end appears, which here would deadlock the boot: the reader
    # and the writer are the same process at this point.
    #
    # Fail the boot if any of it fails. A machine that cannot receive its host
    # list can never be assigned, so booting it anyway would only produce a
    # machine that fails later, at the worst moment — on a caller's request.
    if [[ "$AWAITING_ASSIGNMENT" -eq 1 ]]; then
      chan_dir="/run/skrun-egress"
      rm -rf "$chan_dir"
      if ! mkdir -p -m 0700 "$chan_dir" \
        || ! mkfifo -m 0600 "$chan_dir/request" "$chan_dir/ack"; then
        log "ERROR: could not create the assignment channel"
        exit 3
      fi
      # 3 = the runner writes its host list here; 4 = it reads the confirmation.
      # The loop below inherits both and uses them the other way round.
      exec 3<>"$chan_dir/request" 4<>"$chan_dir/ack"
      log "assignment channel ready (root-only, single message)"
    fi

    # Spawn DNS re-resolve loop as background root child. tini reaps it
    # on container SIGTERM. The loop runs every SKRUN_DNS_RESOLVE_INTERVAL
    # seconds (default 30) and adjusts iptables rules when allowed-host
    # IPs change (CDN rotation).
    #
    # On a pre-created machine it starts by waiting on the channel instead: the
    # host list does not exist yet. It applies the list once it arrives, confirms
    # it, destroys the channel, and only then enters the periodic loop.
    log "spawning DNS re-resolve loop (interval=${SKRUN_DNS_RESOLVE_INTERVAL:-30}s)"
    if [[ "$AWAITING_ASSIGNMENT" -eq 1 ]]; then
      /usr/local/bin/dns-reresolve.sh --await-assignment &
    else
      /usr/local/bin/dns-reresolve.sh "${SKRUN_ALLOWED_HOSTS:-}" &
    fi
    DNS_LOOP_PID=$!
    log "  dns-reresolve PID=$DNS_LOOP_PID"

    # Capsh handoff: switch to uid 1000 (skrun-runner). `--user=USER` does
    # setgroups + setgid + setuid; setuid as non-root auto-drops ALL caps
    # to 0 (Linux default behavior without PR_SET_KEEPCAPS), which is
    # exactly the zero-cap posture we want. After this exec:
    #   - zero capabilities (verified by `capsh --print` → "Current: =")
    #   - uid 1000
    #   - no path back to root (no_new_privileges from compose)
    # The dns-reresolve loop continues running as root in the background.
    #
    # NOTE: 2026-05-25 — removed `--caps=""` from this command. capsh
    # processes args left-to-right; `--caps=""` BEFORE `--user=USER`
    # dropped CAP_SETGID before --user's setgroups() could run, producing
    # "Unable to set group list for user: Operation not permitted" and
    # eventually exit code 1. setuid via --user achieves the same
    # zero-cap end state via the kernel's default cap-drop-on-setuid path.
    log "exec'ing runner-start.sh via capsh handoff (--user=skrun-runner; setuid auto-drops caps)"
    exec capsh --user=skrun-runner -- /usr/local/bin/runner-start.sh
    ;;
  api-server)
    log "self-host mode — no iptables setup, exec'ing api-server-start.sh"
    exec /usr/local/bin/api-server-start.sh
    ;;
  *)
    log "ERROR: unknown SKRUN_CONTAINER_MODE: $MODE (expected: runner | api-server)"
    exit 1
    ;;
esac
