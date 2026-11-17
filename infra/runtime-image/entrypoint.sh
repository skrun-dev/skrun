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
#                             egress except loopback + DNS. `*` = every
#                             address outside the blocked ranges, TCP/25
#                             refused (setup_iptables, net-lib.sh).
#
# Exit codes:
#   0   success — exec'd into runner-start.sh or api-server-start.sh
#   1   unknown mode
#   2   iptables setup failed (missing NET_ADMIN cap?)
#   3   assignment channel could not be created (pre-created machines only)

set -euo pipefail

# Shared egress helpers: setup_iptables (the egress rules, runner mode) and
# is_private_ip (the blocked-range check it and the re-resolve loop apply to each
# resolved address), both reading the ranges file the image build writes from the
# runtime's own list.
source /usr/local/bin/net-lib.sh

MODE="${SKRUN_CONTAINER_MODE:-api-server}"

log() {
  echo "[skrun-entrypoint] $*" >&2
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
    # connections, ICMPv6, the nameservers, the infrastructure hosts, the
    # control-plane return path and the blocked-range drops — the agent's hosts,
    # added at assignment, land after those. Those are the same for every run, so paying for
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
