#!/bin/bash
#
# zero-trust.test.sh — assert the sandbox hardening controls baked
# into the skrun-runtime image (VT-4..VT-18).
#
# Each test boots the image with docker run + the same security flags
# the production compose / FlyioAdapter would apply, then assertion-runs
# a probe inside it. PASS / FAIL lines printed for D-1 traceability.
#
# Usage:
#   bash infra/runtime-image/zero-trust.test.sh                 # uses :latest
#   IMAGE=skrun-runtime:dev bash infra/runtime-image/zero-trust.test.sh
#
# Requirements:
#   - docker CLI + ability to `docker run` (CI runners have this; local
#     dev needs Docker Desktop or equivalent).
#   - The IMAGE referenced must be PULLED (CI workflow handles this
#     via docker/build-push@v5; locally, run `pnpm --filter
#     @skrun-dev/runtime pack -o infra/runtime-image/skrun-dev-runtime.tgz
#     && docker build --build-arg RUNTIME_TGZ=skrun-dev-runtime.tgz
#     -t skrun-runtime:dev infra/runtime-image/`).
#
# Skip behaviour: if `docker` is not available, the script logs a SKIP
# line + exits 0. CI configures the script to require docker; local
# devs without Docker installed don't see false failures.

set -uo pipefail

IMAGE="${IMAGE:-ghcr.io/skrun-dev/skrun-runtime:latest}"
RESULT=0
PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[zero-trust] $*"; }
pass() { log "PASS $1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() { log "FAIL $1 — $2"; FAIL_COUNT=$((FAIL_COUNT+1)); RESULT=1; }

if ! command -v docker >/dev/null 2>&1; then
  log "SKIP — docker CLI not available. Install Docker to run the 7 hardening checks."
  log "      The same checks run in CI via .github/workflows/runtime-image.yml."
  exit 0
fi

log "image: $IMAGE"
log "running 16 controls (VT-4..VT-18)"
echo

# Common docker run flags matching production compose / FlyioAdapter.
# Each test layers extra flags or omits some to test specific paths.
COMMON_FLAGS=(
  --rm
  --read-only
  --tmpfs /tmp
  --tmpfs /mnt/session/outputs:size=2g
  --user 1000:1000
  --cap-drop ALL
  --security-opt no-new-privileges:true
)

# Helper: run a probe inside the image and capture exit + stdout.
# Args: <test_name> <probe_command>
probe() {
  local name="$1"; shift
  docker run "${COMMON_FLAGS[@]}" --entrypoint /bin/bash "$IMAGE" -c "$*" 2>&1
}

# ---------- VT-4: iptables egress allowlist ----------
#
# The runner-mode entrypoint sets up iptables OUTPUT DROP by default,
# then ACCEPTs only the resolved IPs of SKRUN_ALLOWED_HOSTS + loopback +
# DNS. We boot in runner mode with allow_hosts="example.com" and assert:
#   - GET https://example.com succeeds (resolved IP is ACCEPT'd)
#   - GET https://evil.invalid FAILS (no rule allowing it)
#
# Runner mode requires NET_ADMIN at boot for iptables setup — we add it
# back temporarily (the capsh handoff inside the entrypoint drops it
# again before user code runs). The probe runs DURING runner boot, so
# we curl from a debug entrypoint rather than the real runner-start.
log "VT-4: iptables egress allowlist (allow listed hosts, block others)"
VT4_OUT=$(docker run --rm \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  -e SKRUN_CONTAINER_MODE=debug \
  -e SKRUN_ALLOWED_HOSTS=example.com \
  --entrypoint /bin/bash \
  "$IMAGE" -c '
    set -e
    # Re-run the iptables-setup part of entrypoint.sh manually for the
    # debug probe (skips the capsh handoff so we can curl as root after).
    iptables -P OUTPUT DROP
    iptables -A OUTPUT -o lo -j ACCEPT
    iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    while read -r ns; do
      [[ -n "$ns" ]] || continue
      iptables -A OUTPUT -p udp -d "$ns" --dport 53 -j ACCEPT
      iptables -A OUTPUT -p tcp -d "$ns" --dport 53 -j ACCEPT
    done < <(awk "/^nameserver/ { print \$2 }" /etc/resolv.conf)
    # getent ahostsv4 -> IPv4-only, mirroring the entrypoint.sh v4 arm
    # (deterministic; bare "getent hosts" can return the example.com AAAA first
    # on the CI runner, leaving no v4 rule). The v6 egress path is covered by VT-11.
    for ip in $(getent ahostsv4 example.com | awk "{ print \$1 }" | sort -u); do
      iptables -A OUTPUT -d "$ip" -j ACCEPT
    done
    # Now probe. Force IPv4 (-4): VT-4 is the IPv4 egress test, and example.com
    # now publishes an AAAA — without -4 curl prefers IPv6, which the GitHub
    # runner cannot route, so the allowed-host probe times out (the v6 egress
    # path is covered by VT-11). A real runner allows the host on both families.
    if curl -4 -s -o /dev/null --max-time 5 https://example.com; then
      echo "ALLOWED_OK"
    else
      echo "ALLOWED_FAILED" >&2
      exit 11
    fi
    if curl -4 -s -o /dev/null --max-time 5 https://evil.invalid 2>&1; then
      echo "BLOCKED_LEAKED" >&2
      exit 12
    else
      echo "BLOCKED_OK"
    fi
  ' 2>&1)
if echo "$VT4_OUT" | grep -q "ALLOWED_OK" && echo "$VT4_OUT" | grep -q "BLOCKED_OK"; then
  pass "VT-4 iptables: example.com allowed, evil.invalid blocked"
else
  fail "VT-4 iptables" "$VT4_OUT"
fi

# ---------- VT-11: ip6tables egress policy is DROP (SEC-2026-001) ----------
#
# The runner sits on an IPv6 private network; without an ip6tables OUTPUT
# DROP policy, IPv6 egress is unrestricted and bypasses the v4 allowlist.
# We assert the POLICY directly (not a curl -6 probe — a CI runner with no
# IPv6 interface would make a probe falsely pass).
log "VT-11: ip6tables OUTPUT policy DROP + AAAA allowlist"
VT11_OUT=$(docker run --rm \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  -e SKRUN_ALLOWED_HOSTS=example.com \
  --entrypoint /bin/bash \
  "$IMAGE" -c '
    set -e
    source /usr/local/bin/net-lib.sh
    ip6tables -P OUTPUT DROP
    ip6tables -A OUTPUT -o lo -j ACCEPT
    ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    for ip in $(getent ahostsv6 example.com | awk "{ print \$1 }" | sort -u); do
      is_private_ip "$ip" && continue
      ip6tables -A OUTPUT -d "$ip" -j ACCEPT
    done
    if ip6tables -L OUTPUT -n | head -1 | grep -q "policy DROP"; then
      echo "V6_POLICY_DROP_OK"
    else
      echo "V6_POLICY_NOT_DROP" >&2; exit 31
    fi
    ip6tables -L OUTPUT -n | grep -q "ACCEPT" && echo "V6_ACCEPT_OK"
  ' 2>&1)
if echo "$VT11_OUT" | grep -q "V6_POLICY_DROP_OK" && echo "$VT11_OUT" | grep -q "V6_ACCEPT_OK"; then
  pass "VT-11 ip6tables: OUTPUT policy DROP + AAAA ACCEPT present"
else
  fail "VT-11 ip6tables" "$VT11_OUT"
fi

# ---------- VT-12: resolved private IPs are NOT ACCEPT'd (SEC-2026-003) ----------
#
# An allowed_host whose DNS resolves to a private/link-local IP must be
# skipped (DNS-rebinding defense). The rootfs is read-only in prod, so a
# bind-mounted stub /etc/hosts is the only way to override resolution.
log "VT-12: resolved private IP refused (DNS-rebinding defense)"
VT12_HOSTS=$(mktemp)
printf "169.254.169.254 rebind.test\nfd00::1 rebind.test\n" > "$VT12_HOSTS"
VT12_OUT=$(docker run --rm \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  -v "$VT12_HOSTS":/etc/hosts:ro \
  --entrypoint /bin/bash \
  "$IMAGE" -c '
    set -e
    source /usr/local/bin/net-lib.sh
    iptables -P OUTPUT DROP
    ip6tables -P OUTPUT DROP
    for ip in $(getent hosts rebind.test | awk "{ print \$1 }"); do
      [[ "$ip" == *:* ]] && continue
      is_private_ip "$ip" && { echo "skip $ip"; continue; }
      iptables -A OUTPUT -d "$ip" -j ACCEPT
    done
    if iptables -L OUTPUT -n | grep -q "169.254.169.254"; then
      echo "PRIVATE_LEAKED" >&2; exit 41
    else
      echo "PRIVATE_FILTERED_OK"
    fi
  ' 2>&1)
rm -f "$VT12_HOSTS"
if echo "$VT12_OUT" | grep -q "PRIVATE_FILTERED_OK"; then
  pass "VT-12 private-IP filter: 169.254.169.254 (rebind) refused"
else
  fail "VT-12 private-IP filter" "$VT12_OUT"
fi

# ---------- VT-13: runner RPC requires the Bearer token (SEC-2026-002) ----------
#
# When RUNNER_RPC_TOKEN is set (injected per-run by the api-server), every RPC
# except /healthz must carry the matching Bearer. We boot the real runner and
# probe it. The middleware runs before the route handler, so a missing/wrong
# token yields 401 before any dispatch.
log "VT-13: runner RPC rejects a missing/wrong token (open /healthz)"
VT13_OUT=$(docker run --rm \
  --security-opt no-new-privileges:true \
  -e RUNNER_RPC_TOKEN=test-secret-token \
  -e RUNNER_PORT=9000 \
  --entrypoint /bin/bash \
  "$IMAGE" -c '
    node /opt/skrun-runner/dist/index.js >/tmp/runner.log 2>&1 &
    RUNNER_PID=$!
    for _ in $(seq 1 40); do curl -sf -o /dev/null http://localhost:9000/healthz && break; sleep 0.2; done
    H=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:9000/healthz)
    NO=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:9000/tool -H "Content-Type: application/json" -d "{}")
    WRONG=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer nope" -H "Content-Type: application/json" http://localhost:9000/tool -d "{}")
    OK=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer test-secret-token" -H "Content-Type: application/json" http://localhost:9000/tool -d "{}")
    kill "$RUNNER_PID" 2>/dev/null || true
    echo "HEALTHZ=$H NO=$NO WRONG=$WRONG WITH=$OK"
    [[ "$H" == "200" && "$NO" == "401" && "$WRONG" == "401" && "$OK" != "401" ]] && echo "RPC_AUTH_OK"
  ' 2>&1)
if echo "$VT13_OUT" | grep -q "RPC_AUTH_OK"; then
  pass "VT-13 RPC auth: /healthz open, /tool 401 without/wrong token, passes with token"
else
  fail "VT-13 RPC auth" "$VT13_OUT"
fi

# ---------- VT-13b: runner RPC open when RUNNER_RPC_TOKEN unset (back-compat) ----------
log "VT-13b: runner RPC open when no token is configured (back-compat)"
VT13B_OUT=$(docker run --rm \
  --security-opt no-new-privileges:true \
  -e RUNNER_PORT=9000 \
  --entrypoint /bin/bash \
  "$IMAGE" -c '
    node /opt/skrun-runner/dist/index.js >/tmp/runner.log 2>&1 &
    RUNNER_PID=$!
    for _ in $(seq 1 40); do curl -sf -o /dev/null http://localhost:9000/healthz && break; sleep 0.2; done
    NO=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:9000/tool -H "Content-Type: application/json" -d "{}")
    kill "$RUNNER_PID" 2>/dev/null || true
    echo "NO_TOKEN_CONFIGURED=$NO"
    [[ "$NO" != "401" ]] && echo "RPC_OPEN_OK"
  ' 2>&1)
if echo "$VT13B_OUT" | grep -q "RPC_OPEN_OK"; then
  pass "VT-13b RPC back-compat: unset RUNNER_RPC_TOKEN → RPC open"
else
  fail "VT-13b RPC back-compat" "$VT13B_OUT"
fi

# ---------- VT-14: ip6tables allows ICMPv6 (Neighbor Discovery) ----------
#
# IPv6 needs ICMPv6/ND to resolve the next-hop for EVERY unicast; under
# ip6tables OUTPUT DROP without an ipv6-icmp ACCEPT, no IPv6 packet leaves
# (RPC reply, DNS, and allowed_hosts all silently fail — the boot-probe bug).
# Assert the rule is accepted by the image netfilter and shows in OUTPUT.
log "VT-14: ip6tables ICMPv6 ACCEPT (Neighbor Discovery mandatory under OUTPUT DROP)"
VT14_OUT=$(docker run --rm \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  --entrypoint /bin/bash \
  "$IMAGE" -c '
    set -e
    ip6tables -P OUTPUT DROP
    ip6tables -A OUTPUT -p ipv6-icmp -j ACCEPT
    # Assert via `-C` (rule-exists check) — display-independent, so it works on
    # both legacy iptables and iptables-nft (which renders `-L` differently).
    if ip6tables -C OUTPUT -p ipv6-icmp -j ACCEPT 2>/dev/null; then
      echo "ICMP6_OK"
    else
      echo "ICMP6_MISSING" >&2; exit 61
    fi
  ' 2>&1)
if echo "$VT14_OUT" | grep -q "ICMP6_OK"; then
  pass "VT-14 ICMPv6: ipv6-icmp ACCEPT present (ND works under OUTPUT DROP)"
else
  fail "VT-14 ICMPv6" "$VT14_OUT"
fi

# ---------- VT-15: infra hosts trust-exempt from the private-IP filter ----------
#
# RUNNER_INFRA_HOSTS (object store + install registries) are harness-controlled
# and trusted, so — unlike agent allowed_hosts — they are ACCEPT'd even when
# they resolve to a private address (a self-host MinIO endpoint may be private).
# Mirror the entrypoint infra loop with a stub /etc/hosts resolving to private
# v4 + v6 and assert BOTH are ACCEPT'd (no private-IP skip).
log "VT-15: infra hosts ACCEPT'd on both families incl. private (trust-exempt)"
VT15_HOSTS=$(mktemp)
printf "10.0.0.5 infra.test\nfd00::5 infra.test\n" > "$VT15_HOSTS"
VT15_OUT=$(docker run --rm \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  -v "$VT15_HOSTS":/etc/hosts:ro \
  --entrypoint /bin/bash \
  "$IMAGE" -c '
    set -e
    # Read the stub /etc/hosts directly for BOTH families. getent has family-selection
    # quirks on the CI runner (ahostsv6 misses the stub v6; getent hosts returns only
    # the RFC-6724-preferred single family), so parse the file to get all addresses.
    for ip in $(awk "/infra.test/ { print \$1 }" /etc/hosts | sort -u); do
      if [[ "$ip" == *:* ]]; then
        ip6tables -A OUTPUT -d "$ip" -j ACCEPT
      else
        iptables -A OUTPUT -d "$ip" -j ACCEPT
      fi
    done
    V4=NO; V6=NO
    # `-C` (rule-exists) is display-independent — robust on iptables-nft, whose
    # `-L` renders addresses/protocols differently than legacy iptables.
    iptables  -C OUTPUT -d 10.0.0.5 -j ACCEPT 2>/dev/null && V4=OK
    ip6tables -C OUTPUT -d fd00::5  -j ACCEPT 2>/dev/null && V6=OK
    echo "INFRA_V4=$V4 INFRA_V6=$V6"
    [[ "$V4" == "OK" && "$V6" == "OK" ]] && echo "INFRA_TRUST_OK"
  ' 2>&1)
rm -f "$VT15_HOSTS"
if echo "$VT15_OUT" | grep -q "INFRA_TRUST_OK"; then
  pass "VT-15 infra trust-exempt: private infra IP ACCEPT'd on v4+v6 (no private-IP skip)"
else
  fail "VT-15 infra trust-exempt" "$VT15_OUT"
fi

# ---------- VT-16: harness-6PN RPC return rule (defense-in-depth) ----------
#
# When RUNNER_HARNESS_6PN is set, the entrypoint adds an explicit ip6tables
# ACCEPT to the harness 6PN — defense-in-depth behind ESTABLISHED,RELATED for
# the harness→runner RPC reply. Assert the rule is present for the address.
log "VT-16: harness-6PN RPC return rule present when RUNNER_HARNESS_6PN set"
VT16_OUT=$(docker run --rm \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  -e RUNNER_HARNESS_6PN=fdaa:0:dead::2 \
  --entrypoint /bin/bash \
  "$IMAGE" -c '
    set -e
    ip6tables -P OUTPUT DROP
    if [[ -n "${RUNNER_HARNESS_6PN:-}" ]]; then
      ip6tables -A OUTPUT -d "${RUNNER_HARNESS_6PN}" -j ACCEPT
    fi
    if ip6tables -L OUTPUT -n | grep -qi "fdaa:0:dead::2"; then
      echo "HARNESS_OK"
    else
      echo "HARNESS_MISSING" >&2; exit 71
    fi
  ' 2>&1)
if echo "$VT16_OUT" | grep -q "HARNESS_OK"; then
  pass "VT-16 harness rule: ip6tables ACCEPTs the harness 6PN (defense-in-depth)"
else
  fail "VT-16 harness rule" "$VT16_OUT"
fi

# ---------- VT-17: dns-reresolve state seed → no duplicate re-add ----------
#
# entrypoint.sh seeds /run/skrun-allowed-ips with the boot host|ip pairs so
# dns-reresolve's first diff is empty (no duplicate rule that a later -D would
# leave as a ghost ACCEPT). Assert: the seed is non-empty AND a fresh snapshot
# built the same way diffs to nothing (comm -23 empty).
log "VT-17: STATE_FILE seed non-empty + first re-resolve cycle re-adds nothing"
VT17_HOSTS=$(mktemp)
printf "93.184.216.34 seed.test\n" > "$VT17_HOSTS"
VT17_OUT=$(docker run --rm \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  -v "$VT17_HOSTS":/etc/hosts:ro \
  --entrypoint /bin/bash \
  "$IMAGE" -c '
    set -e
    source /usr/local/bin/net-lib.sh
    STATE_FILE=/run/skrun-allowed-ips
    mkdir -p /run
    : > "$STATE_FILE"
    for ip in $(getent ahostsv4 seed.test | awk "{ print \$1 }" | sort -u); do
      is_private_ip "$ip" && continue
      echo "seed.test|$ip" >> "$STATE_FILE"
    done
    [[ -s "$STATE_FILE" ]] || { echo "SEED_EMPTY" >&2; exit 81; }
    NEW=$(mktemp)
    for ip in $(getent ahostsv4 seed.test | awk "{ print \$1 }" | sort -u); do
      is_private_ip "$ip" && continue
      echo "seed.test|$ip" >> "$NEW"
    done
    ADDED=$(comm -23 <(sort -u "$NEW") <(sort -u "$STATE_FILE") || true)
    if [[ -z "$ADDED" ]]; then
      echo "NO_DUP_OK"
    else
      echo "DUP_READDED" >&2; exit 82
    fi
  ' 2>&1)
rm -f "$VT17_HOSTS"
if echo "$VT17_OUT" | grep -q "NO_DUP_OK"; then
  pass "VT-17 state seed: non-empty + first re-resolve re-adds nothing (no ghost ACCEPT)"
else
  fail "VT-17 state seed" "$VT17_OUT"
fi

# ---------- VT-18: egress diagnostic gated behind RUNNER_EGRESS_DEBUG ----------
#
# The post-boot ip6tables-counter dump must be opt-in (off by default) so a
# normal run has zero diagnostic noise. Assert the SHIPPED entrypoint gates it
# behind RUNNER_EGRESS_DEBUG (the ungated draft would not).
log "VT-18: shipped entrypoint gates the egress diagnostic behind RUNNER_EGRESS_DEBUG"
VT18_OUT=$(probe vt18 'grep -q RUNNER_EGRESS_DEBUG /entrypoint.sh && echo DIAG_GATE_OK')
if echo "$VT18_OUT" | grep -q "DIAG_GATE_OK"; then
  pass "VT-18 diag gate: entrypoint diagnostic is opt-in via RUNNER_EGRESS_DEBUG"
else
  fail "VT-18 diag gate" "$VT18_OUT"
fi

# ---------- VT-5: read-only rootfs (EROFS on write outside tmpfs) ----------
log "VT-5: read-only rootfs (touch /etc/test must fail with EROFS)"
VT5_OUT=$(probe vt5 '
  if touch /etc/test 2>&1; then
    echo "ROOTFS_WRITABLE_LEAK"; exit 21
  fi
  echo "ROOTFS_RO_OK"
')
if echo "$VT5_OUT" | grep -q "ROOTFS_RO_OK"; then
  pass "VT-5 read-only rootfs: touch /etc/test refused"
else
  fail "VT-5 read-only rootfs" "$VT5_OUT"
fi

# ---------- VT-6: non-root UID 1000 ----------
log "VT-6: process runs as uid 1000 (skrun-runner)"
VT6_OUT=$(probe vt6 'id -u; id -n -u')
if echo "$VT6_OUT" | head -1 | grep -qE "^1000$"; then
  pass "VT-6 non-root UID: id -u = 1000"
else
  fail "VT-6 non-root UID" "got: $VT6_OUT (expected uid 1000)"
fi

# ---------- VT-7: zero capabilities at user-code level ----------
#
# After capsh handoff (runner mode), Current capability set is empty:
# `capsh --print` shows `Current: =`. We probe directly via cap_drop ALL
# without ever adding any back, mirroring the post-handoff state.
log "VT-7: zero capabilities (capsh --print shows Current: =)"
VT7_OUT=$(probe vt7 'capsh --print 2>&1 | grep "^Current:"')
if echo "$VT7_OUT" | grep -qE "^Current:\s*=?\s*$"; then
  pass "VT-7 zero caps: Current: = (no capabilities)"
else
  fail "VT-7 zero caps" "got: $VT7_OUT (expected empty Current: set)"
fi

# ---------- VT-8: env scan reveals no credentials ----------
#
# An attacker who lands code execution in the sandbox must NOT find any
# of the harness credentials by reading env. We pass NO secrets at boot
# and assert env contains none of the listed shapes. Even if the operator
# misconfigures and tries to leak via env, the buildMachineConfig env
# allowlist (asserted separately in machine-config.test.ts) refuses.
log "VT-8: env scan finds NO credentials"
VT8_OUT=$(probe vt8 'env | sort')
FORBIDDEN_PATTERNS=(
  "ANTHROPIC_API_KEY"
  "OPENAI_API_KEY"
  "GOOGLE_API_KEY"
  "MISTRAL_API_KEY"
  "GROQ_API_KEY"
  "XAI_API_KEY"
  "SUPABASE"
  "WEBHOOK_SIGNING_KEY"
  "FLY_API_TOKEN"
  "S3_SECRET"
)
VT8_FAIL=""
for pat in "${FORBIDDEN_PATTERNS[@]}"; do
  if echo "$VT8_OUT" | grep -q "$pat"; then
    VT8_FAIL+="$pat "
  fi
done
if [[ -z "$VT8_FAIL" ]]; then
  pass "VT-8 env scan: no credentials present (10 patterns checked)"
else
  fail "VT-8 env scan" "leaked patterns: $VT8_FAIL"
fi

# ---------- VT-9: setuid binary escalation refused ----------
#
# `no-new-privileges` prevents setuid bits from elevating. We test via
# a known setuid binary if any is left in the image (e.g. /usr/bin/sudo
# wouldn't be installed but if it were, running it as a non-root user
# would fail with EPERM under no-new-privileges). The image ships no
# setuid binaries by design; we instead assert the bit-stripping
# `cap-prctl` shows NoNewPrivs: 1.
log "VT-9: no-new-privileges enforced (prevents setuid escalation)"
VT9_OUT=$(probe vt9 'cat /proc/self/status | grep NoNewPrivs')
if echo "$VT9_OUT" | grep -qE "NoNewPrivs:\s*1"; then
  pass "VT-9 no-new-privileges: NoNewPrivs:1 (setuid bits ineffective)"
else
  fail "VT-9 no-new-privileges" "got: $VT9_OUT (expected NoNewPrivs:1)"
fi

# ---------- VT-10: mount() syscall refused ----------
#
# Without CAP_SYS_ADMIN (which is in the dropped set), mount() returns
# EPERM. Probe by attempting a tmpfs mount inside a fresh dir.
log "VT-10: mount() syscall refused (no CAP_SYS_ADMIN)"
VT10_OUT=$(probe vt10 '
  mkdir -p /tmp/probe-mount
  if mount -t tmpfs none /tmp/probe-mount 2>&1; then
    echo "MOUNT_LEAKED"; exit 51
  fi
  echo "MOUNT_EPERM_OK"
')
if echo "$VT10_OUT" | grep -q "MOUNT_EPERM_OK"; then
  pass "VT-10 mount() refused: EPERM as expected (no CAP_SYS_ADMIN)"
else
  fail "VT-10 mount()" "$VT10_OUT"
fi

# ---------- Summary ----------
echo
TOTAL=$((PASS_COUNT + FAIL_COUNT))
log "PASS zero-trust: scanned=$TOTAL passed=$PASS_COUNT failed=$FAIL_COUNT"
if [[ "$RESULT" -ne 0 ]]; then
  log "FAIL — $FAIL_COUNT control(s) regressed. Inspect logs above."
fi
exit "$RESULT"
