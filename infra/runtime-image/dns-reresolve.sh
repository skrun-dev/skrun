#!/bin/bash
#
# DNS re-resolve loop — periodically updates the iptables egress allowlist
# to track short-TTL hostnames (CDN-fronted endpoints whose IPs rotate) —
# and what starts the guardian of the machine's lifetime (below).
#
# Spawned as a background child of entrypoint.sh in `runner` mode before
# the capsh handoff. Runs as root throughout — capsh drops the user-code
# child to non-root with zero caps, but this loop must keep CAP_NET_ADMIN
# to call `iptables -A/-D`. tini reaps it on container SIGTERM.
#
# Inputs:
#   $1                            CSV of hostnames (same value as
#                                 SKRUN_ALLOWED_HOSTS passed to entrypoint).
#   SKRUN_DNS_RESOLVE_INTERVAL    sleep between cycles, in whole seconds
#                                 (default 30).
#   RUNNER_LIFETIME_S             how long a machine created for a run may
#                                 live, in whole seconds. A pre-created machine
#                                 is given its own on the assignment channel.
#
# State:
#   /run/skrun-allowed-ips        snapshot of "host|ip" pairs currently
#                                 ACCEPT'd (v4 + v6). Diffed each cycle to
#                                 compute ADD/DEL ops against ip(6)tables.

# `set -uo pipefail` deliberately WITHOUT `-e`: the ip6tables/iptables -D calls in
# the loop fail on already-removed rules and are handled with `|| log`; a global
# `-e` would abort the loop on the first such expected failure.
set -uo pipefail

# Shared egress helpers (is_private_ip, the blocked-range check).
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

# A cycle that cannot wait would spin: the loop below goes on past a failed
# sleep, so the interval is a whole number of seconds above zero, or the default.
if [[ ! "$INTERVAL" =~ ^[1-9][0-9]{0,5}$ ]]; then
  log "SKRUN_DNS_RESOLVE_INTERVAL is not a whole number of seconds above zero — using 30"
  INTERVAL=30
fi

# ---------------------------------------------------------------------------
# The lifetime guardian
#
# A machine nobody destroyed — its server died, slept, or lost its database —
# must still end. Nothing in the runner can be relied on for that: the agent's
# code runs under the runner's user and can freeze it or kill it. This loop is
# root, and a process of that user cannot signal it.
#
# Armed with a lifetime in whole seconds — at the start of a machine created for
# a run (RUNNER_LIFETIME_S), at the assignment of a pre-created one (the
# channel), in both cases before any of the agent's code runs —, the deadline is
# counted in seconds the machine has been up (/proc/uptime), never by a timer.
# Reached, the runner is sent TERM, then KILL once GUARDIAN_KILL_DELAY_S have
# passed: a frozen runner never handles TERM. The runner is the image's main
# process, so its end stops the machine.
#
# The guardian is not this loop. A bash script that cannot start a process — a
# process table the agent's code has filled refuses root's forks too — ends,
# whatever follows the command (bash retries for some 15 s, then exits), and a
# cycle of this loop waits on every host's resolution. So the arming starts the
# guardian once, a loop of its own (guardian_loop, a subshell of this script),
# which from then on starts no process: it waits on the read builtin's timeout,
# on a descriptor nothing writes, reads the clock by a redirection and signals
# with the kill builtin. It reads the deadline every second; neither a full
# table, nor this loop's end, nor a slow cycle moves it. It also puts itself out
# of the OOM killer's reach, where the machine lets root lower its score.
# ---------------------------------------------------------------------------

# The runner: the process that started this loop. The entrypoint starts it, then
# becomes the runner through successive execs — the same PID throughout. Taken
# now, once, by this script — the guardian, a subshell, inherits the value; its
# own $PPID would not name its parent. The runner's name is read at the
# deadline, for the log line only.
RUNNER_PID=$PPID
# How long the runner has after TERM before KILL — past its own forced exit.
GUARDIAN_KILL_DELAY_S=15
# The deadline, in seconds of uptime; 0 while nothing is armed.
LIFETIME_DEADLINE=0
UPTIME_S=0
# The guardian's wait: a FIFO only root can reach, opened read-write — at once,
# where one end alone would block until the other appeared — and unlinked before
# the guardian starts, which then holds the only descriptor on it, both ends:
# nothing can open it again, nothing writes in it, and a read on it lasts its
# whole timeout.
GUARDIAN_WAIT_FIFO=/run/skrun-guardian-wait

# Sets UPTIME_S to the whole seconds the machine has been up.
read_uptime() {
  local up rest
  read -r up rest < /proc/uptime || return 1
  up="${up%.*}"
  [[ "$up" =~ ^[0-9]{1,15}$ ]] || return 1
  UPTIME_S=$((10#$up))
}

# guardian_loop <wait descriptor> — the guardian, run in a subshell of its own.
# From its first line on it starts no process — builtins and redirections only:
# a subshell, a pipe, a command substitution or an external command here would
# each be a fork, which a full process table refuses, ending the guardian.
guardian_loop() {
  local wait_fd="$1" adj="unknown" comm="unknown" kill_at _
  # The channel's descriptors, inherited at an assignment: not the guardian's.
  exec 3<&- 4<&-
  # A log line it cannot write must not end it.
  trap '' PIPE
  # Out of the OOM killer's reach: root may lower its score, where the machine
  # grants it the capability (a container's root may lack it).
  { printf '%s\n' -1000 > /proc/self/oom_score_adj; } 2>/dev/null
  read -r adj 2>/dev/null < /proc/self/oom_score_adj || adj="unknown"
  log "lifetime_guardian pid=$BASHPID runner_pid=$RUNNER_PID oom_score_adj=$adj deadline_uptime_s=$LIFETIME_DEADLINE"
  # Every second, the deadline read against the machine's uptime.
  while :; do
    read_uptime && (( UPTIME_S >= LIFETIME_DEADLINE )) && break
    read -r -t 1 -u "$wait_fd" _
  done
  read -r comm 2>/dev/null < "/proc/$RUNNER_PID/comm" || comm="gone"
  log "lifetime_reached runner_pid=$RUNNER_PID comm=$comm uptime_s=$UPTIME_S deadline_uptime_s=$LIFETIME_DEADLINE — TERM, then KILL after ${GUARDIAN_KILL_DELAY_S}s"
  kill -TERM "$RUNNER_PID" 2>/dev/null || true
  kill_at=$((UPTIME_S + GUARDIAN_KILL_DELAY_S))
  # Waited on the clock, a second at a time: the delay is the clock's, whatever
  # a wait lasts.
  while kill -0 "$RUNNER_PID" 2>/dev/null; do
    read_uptime || break
    (( UPTIME_S >= kill_at )) && break
    read -r -t 1 -u "$wait_fd" _
  done
  if kill -0 "$RUNNER_PID" 2>/dev/null; then
    log "lifetime_kill runner_pid=$RUNNER_PID — still there ${GUARDIAN_KILL_DELAY_S}s after TERM"
    kill -KILL "$RUNNER_PID" 2>/dev/null || true
  fi
  exit 0
}

# start_guardian — opens the guardian's wait, then starts the guardian: the one
# fork the lifetime costs, made before any of the agent's code runs. Fails when
# the wait cannot be opened as a FIFO: the guardian would not wait, it would spin.
start_guardian() {
  local wait_fd
  rm -f "$GUARDIAN_WAIT_FIFO"
  if ! mkfifo -m 0600 "$GUARDIAN_WAIT_FIFO" || ! exec {wait_fd}<>"$GUARDIAN_WAIT_FIFO"; then
    rm -f "$GUARDIAN_WAIT_FIFO"
    return 1
  fi
  rm -f "$GUARDIAN_WAIT_FIFO"
  if [[ ! -p "/proc/self/fd/$wait_fd" ]]; then
    exec {wait_fd}<&-
    return 1
  fi
  guardian_loop "$wait_fd" &
  # This loop keeps no end of the guardian's wait: its children never inherit one.
  exec {wait_fd}<&-
}

# arm_lifetime <seconds, as received> <where from> — arms the deadline and starts
# the guardian. Anything but 1 to 10 digits above zero arms nothing, and says so:
# past ten digits, the sum could overflow into a deadline already passed. Called
# once at most: at the start, or at the assignment.
arm_lifetime() {
  local raw="$1" from="$2" reason=""
  if [[ -z "$raw" ]]; then
    reason="absent"
  elif [[ ! "$raw" =~ ^[0-9]{1,10}$ ]]; then
    reason="not 1 to 10 digits"
  elif (( 10#$raw == 0 )); then
    reason="zero"
  fi
  if [[ -n "$reason" ]]; then
    log "lifetime_invalid from=$from reason=$reason — nothing armed"
    return 1
  fi
  if ! read_uptime; then
    log "lifetime_unarmed from=$from reason=uptime-unreadable — nothing armed"
    return 1
  fi
  LIFETIME_DEADLINE=$((UPTIME_S + 10#$raw))
  if ! start_guardian; then
    LIFETIME_DEADLINE=0
    log "lifetime_unarmed from=$from reason=guardian-unstarted — the wait at $GUARDIAN_WAIT_FIFO could not be opened as a FIFO; nothing armed"
    return 1
  fi
  log "lifetime_armed from=$from lifetime_s=$((10#$raw)) uptime_s=$UPTIME_S deadline_uptime_s=$LIFETIME_DEADLINE runner_pid=$RUNNER_PID"
}

# A machine created for a run is armed now; a pre-created one waits for its
# assignment, its environment carrying no lifetime of its own.
if [[ "$AWAIT_MODE" -eq 0 ]]; then
  arm_lifetime "${RUNNER_LIFETIME_S:-}" environment || true
fi

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
# never enter the snapshot (and thus never get ACCEPT'd). `*` — and any other
# pattern — is not a name: it has no address to follow, so it is skipped.
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
    [[ "$host" == *"*"* ]] && continue
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
# The message is one line, "<lifetime>;<hosts>": the machine's lifetime in whole
# seconds — empty when none was given —, then the agent's hosts, comma-separated.
# A line without ';' is the older form, the hosts alone. Any other line is refused,
# nothing armed and no rule installed.
#
# Reads fd 3 (the request), answers on fd 4. Both were opened and handed over by
# the entrypoint before the privilege drop.
# ---------------------------------------------------------------------------

# How many rules the assignment tried to install; read when it is refused, to say so.
ASSIGN_RULES_ADDED=0

# Resolve one host list and ACCEPT each address, mirroring the boot-time path:
# same private/link-local refusal (so a rebinding answer can never open a route to
# the internal network), same state-file seeding so the periodic diff below starts
# from a truthful snapshot, same meaning for `*`. Everything is appended after the
# blocked-range drops the boot installed. The whole list is judged — each entry's
# form, each IPv6 literal's address, the drops `*` needs — before the first rule:
# a list refused installs nothing. Prints nothing; returns non-zero on a bad list,
# when `*` cannot be applied behind those drops, or when its rules fail.
apply_assigned_hosts() {
  local csv="$1" host addr addrs open_egress=0 i
  local -a names=() resolved=()
  [[ -z "$csv" ]] && return 0   # an agent may legitimately declare no hosts
  IFS=',' read -ra hosts <<< "$csv"
  for host in "${hosts[@]}"; do
    host="${host// /}"
    [[ -z "$host" ]] && continue
    # `*` resolves nothing; it is applied once the named hosts are in (below).
    if [[ "$host" == "*" ]]; then
      open_egress=1
      continue
    fi
    # Refuse anything else that is neither plausibly a hostname nor an IPv6 literal
    # before it reaches getent.
    if [[ "$host" =~ ^[A-Za-z0-9._-]+$ ]]; then
      addrs=$(resolve_v4 "$host"; resolve_v6 "$host")
    elif [[ "$host" =~ ^[0-9A-Fa-f:.]+$ ]]; then
      # Holding ':', it is no name: an IPv6 literal — the server passes one bare —,
      # or nothing. Its address is the one getent reads in it, whatever the spelling
      # (zeros written out or compressed, either case), exactly as the boot does:
      # one address, or the entry is refused.
      addrs=$(resolve_v6 "$host")
      if [[ -z "$addrs" || "$addrs" == *$'\n'* ]]; then
        log "ASSIGN refusing malformed host: $host (not an IPv6 literal)"
        return 1
      fi
    else
      log "ASSIGN refusing malformed host: $host"
      return 1
    fi
    names+=("$host")
    resolved+=("$addrs")
  done
  # Only behind the drops: without them, `*` would open the internal network.
  if [[ "$open_egress" -eq 1 ]] && ! blocked_ranges_in_place; then
    log "ASSIGN refusing '*': the blocked-range drops are not all in place"
    return 1
  fi
  for i in "${!names[@]}"; do
    host="${names[$i]}"
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
      ASSIGN_RULES_ADDED=$((ASSIGN_RULES_ADDED + 1))
      echo "$host|$addr" >> "$STATE_FILE"
      log "ASSIGN  $host → $addr — ACCEPT"
    done <<< "${resolved[$i]}"
  done
  if [[ "$open_egress" -eq 1 ]]; then
    # Counted before they are tried: some may be in when the others fail.
    ASSIGN_RULES_ADDED=$((ASSIGN_RULES_ADDED + 1))
    allow_open_egress || { log "ASSIGN the rules for '*' could not be installed"; return 1; }
    log "ASSIGN  * — every address outside the blocked ranges, TCP/25 refused"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# The infrastructure check (pre-created machines only)
#
# The infrastructure hosts — the object store, the package registries — are opened
# once, at boot, and never re-resolved; the boot keeps the addresses it opened
# (INFRA_SNAPSHOT_FILE, net-lib.sh). A pre-created machine may sleep long before its
# assignment. Once the assignment is answered, the loop resolves those hosts again,
# exactly as the boot did, and writes one word — it changes no rule, it measures:
#   changed     a host resolves now to an address absent from the snapshot: the
#               boot opened no rule for it
#   unmeasured  no snapshot, or a host that resolves to nothing now
#   unchanged   otherwise — an address gone from a host cuts no route
# In the background, after the answer: neither the assignment nor the next cycle
# waits on it. In /run, the directory only root may write in, through a temporary
# file renamed into place: the runner, under another user, reads the word and can
# neither write, remove nor replace it.
# ---------------------------------------------------------------------------
INFRA_CHECK=/run/skrun-infra-check

infra_check() {
  local verdict=unchanged known ihost iaddr resolved tmp=""
  if [[ ! -f "$INFRA_SNAPSHOT_FILE" ]]; then
    verdict=unmeasured
    log "infra_check: no snapshot of the boot at $INFRA_SNAPSHOT_FILE"
  elif [[ -n "${RUNNER_INFRA_HOSTS:-}" ]]; then
    known=$(cut -d'|' -f2 "$INFRA_SNAPSHOT_FILE")
    IFS=',' read -ra infra_hosts <<< "$RUNNER_INFRA_HOSTS"
    for ihost in "${infra_hosts[@]}"; do
      ihost="${ihost// /}"
      [[ -z "$ihost" ]] && continue
      resolved=$(resolve_v4 "$ihost"; resolve_v6 "$ihost")
      if [[ -z "$resolved" ]]; then
        log "infra_check: $ihost resolves to nothing"
        [[ "$verdict" == changed ]] || verdict=unmeasured
        continue
      fi
      while IFS= read -r iaddr; do
        [[ -z "$iaddr" ]] && continue
        if ! grep -qxF -- "$iaddr" <<< "$known"; then
          log "infra_check: $ihost → $iaddr, which the boot opened no rule for"
          verdict=changed
        fi
      done <<< "$resolved"
    done
  fi
  if tmp=$(mktemp "$INFRA_CHECK.XXXXXX") && printf '%s\n' "$verdict" > "$tmp" &&
    chmod 0644 "$tmp" && mv -f "$tmp" "$INFRA_CHECK"; then
    log "infra_check $verdict"
  else
    [[ -n "$tmp" ]] && rm -f "$tmp"
    log "infra_check $verdict — WARNING: could not write $INFRA_CHECK"
  fi
}

if [[ "$AWAIT_MODE" -eq 1 ]]; then
  log "awaiting assignment on the channel"
  assignment_applied=0
  if IFS= read -r assigned_line <&3; then
    assigned_csv=""
    line_ok=1
    if [[ "$assigned_line" != *";"* ]]; then
      assigned_csv="$assigned_line"
      arm_lifetime "" channel || true
    elif [[ "${assigned_line%%;*}" =~ ^[0-9]*$ ]]; then
      assigned_csv="${assigned_line#*;}"
      # Armed before the hosts are applied: a machine whose assignment is then
      # refused still ends at its lifetime.
      arm_lifetime "${assigned_line%%;*}" channel || true
    else
      log "ASSIGN refusing a malformed assignment line: the lifetime before ';' is not digits"
      line_ok=0
    fi
    if [[ "$line_ok" -eq 1 ]] && apply_assigned_hosts "$assigned_csv"; then
      HOSTS_CSV="$assigned_csv"
      echo "OK" >&4
      assignment_applied=1
      log "assignment applied (${HOSTS_CSV:-no hosts}); channel closing"
    else
      # Fail closed, and the caller is told so. It will not hand the machine a run
      # — the machine is spent, not retried. A list refused for an entry, or for
      # `*` without the drops, installed nothing; one refused while its rules were
      # being installed may have left some, which the line says.
      echo "REFUSED" >&4
      if [[ "$ASSIGN_RULES_ADDED" -eq 0 ]]; then
        log "assignment refused — no rules installed"
      else
        log "assignment refused — rules were tried before the refusal; the machine is not to be used"
      fi
    fi
  else
    log "channel closed before an assignment arrived"
  fi
  # One message, then gone: unlink both ends and release the descriptors, so
  # nothing that starts later can find or use the channel.
  exec 3<&- 4<&-
  rm -rf "$CHANNEL_DIR" 2>/dev/null || log "WARNING: could not remove $CHANNEL_DIR"
  # Answered, then measured: the channel is gone before the measurement begins.
  if [[ "$assignment_applied" -eq 1 ]]; then
    infra_check &
  fi
fi

# A sleep that fails — one killed, say — is a short cycle, never the end of the
# loop. A fork refused ends it all the same, a bash script ending on a process it
# cannot start: what this loop does not do, then, is the guardian's work.
while :; do
  sleep "$INTERVAL" || true
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
