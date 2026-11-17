#!/bin/bash
#
# zero-trust.test.sh — assert the sandbox hardening controls baked
# into the skrun-runtime image.
#
# Each test boots the image with docker run + hardening flags, then
# assertion-runs a probe inside it, and prints one PASS or FAIL line per
# control. The flags of probe() below are the self-host compose posture,
# read-only root filesystem included; the cloud sandbox's runner machine has a
# writable root filesystem (it writes the agent's bundle under /mnt/agent and its
# dependencies under /tmp), so the read-only root filesystem control below holds
# for the compose posture only.
#
# The egress cases near the end differ: they boot the image's own entrypoint in
# runner mode and probe the machine it set up, on an IPv6-enabled Docker network
# the script creates and removes.
#
# It also reads the version of npm in the image, whose major must stay below
# a ceiling (see npm_major_below below).
#
# Usage:
#   bash infra/runtime-image/zero-trust.test.sh                 # uses :latest
#   IMAGE=skrun-runtime:dev bash infra/runtime-image/zero-trust.test.sh
#   bash infra/runtime-image/zero-trust.test.sh --self-test     # npm comparison witnesses only, no Docker
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
# line + exits 0 — or 1 if a witness of the npm comparison was wrong, since
# the witnesses run before that check. CI configures the script to require
# docker; local devs without Docker installed don't see false failures.

set -uo pipefail

IMAGE="${IMAGE:-ghcr.io/skrun-dev/skrun-runtime:latest}"
RESULT=0
PASS_COUNT=0
FAIL_COUNT=0

log()  { echo "[zero-trust] $*"; }
pass() { log "PASS $1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() { log "FAIL $1 — $2"; FAIL_COUNT=$((FAIL_COUNT+1)); RESULT=1; }

# ---------- npm major below the ceiling: the comparison and its witnesses ----------
#
# npm 12 turns the install scripts of dependencies off by default: a package
# whose install script never ran installs without an error, then breaks when
# an agent script loads it. The npm of this image installs the dependencies of
# agent scripts, so moving to npm 12 must be a decision, never the side effect
# of a Node bump. The assertion itself runs on the image, after the hardening
# controls below.
#
# The ceiling is a constant on purpose: an environment override would be a
# switch that turns the guard off.
NPM_MAJOR_CEILING=12

# npm_major_below <version> <ceiling> — 0 when the version's major is an
# integer below <ceiling>, 1 otherwise. Fail-closed: an empty or unreadable
# version is below nothing.
npm_major_below() {
  local version="$1" ceiling="$2"
  local major="${version%%.*}"
  local major_re='^(0|[1-9][0-9]{0,8})$' ceiling_re='^[1-9][0-9]{0,8}$'
  [[ "$major" =~ $major_re && "$ceiling" =~ $ceiling_re ]] || return 1
  [[ "$major" -lt "$ceiling" ]]
}

# The witnesses run on every pass, before the Docker check, against a literal
# ceiling of 12 that NPM_MAJOR_CEILING does not move: lowering the setting to
# watch the assertion fail leaves them green.
npm_witness() {
  local version="$1" expected="$2" got="not below"
  if npm_major_below "$version" 12; then got="below"; fi
  if [[ "$got" == "$expected" ]]; then
    log "witness: npm '$version' is $got 12, as expected"
  else
    fail "npm comparison witness '$version'" "expected $expected 12, got $got"
  fi
}
npm_witness "10.9.0" "below"
npm_witness "11.0.0" "below"
npm_witness "12.0.2" "not below"
npm_witness "" "not below"

if [[ "${1:-}" == "--self-test" ]]; then
  log "self-test: 4 witnesses of the npm comparison, $FAIL_COUNT wrong"
  exit "$RESULT"
fi

if ! command -v docker >/dev/null 2>&1; then
  log "SKIP — docker CLI not available. Install Docker to run the 7 hardening checks."
  log "      The same checks run in CI via .github/workflows/runtime-image.yml."
  exit "$RESULT"
fi

log "image: $IMAGE"
log "running 60 controls (59 hardening controls, then the npm major)"
echo

# Common docker run flags: the self-host compose posture. The cloud runner
# machine is not started with these flags — its root filesystem, for one, is
# writable. Each test layers extra flags or omits some to test specific paths.
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

# ---------- IPv4 egress allowlist (iptables) ----------
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
log "IPv4 egress allowlist: iptables allows listed hosts, blocks others"
EGRESS_V4_OUT=$(docker run --rm \
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
    # on the CI runner, leaving no v4 rule). The IPv6 policy case covers the v6 path.
    for ip in $(getent ahostsv4 example.com | awk "{ print \$1 }" | sort -u); do
      iptables -A OUTPUT -d "$ip" -j ACCEPT
    done
    # Now probe. Force IPv4 (-4): this is the IPv4 egress case, and example.com
    # now publishes an AAAA — without -4 curl prefers IPv6, which the GitHub
    # runner cannot route, so the allowed-host probe times out (the v6 egress
    # path is covered by the IPv6 policy case). A real runner allows the host on both families.
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
if echo "$EGRESS_V4_OUT" | grep -q "ALLOWED_OK" && echo "$EGRESS_V4_OUT" | grep -q "BLOCKED_OK"; then
  pass "IPv4 egress allowlist: example.com allowed, evil.invalid blocked"
else
  fail "IPv4 egress allowlist" "$EGRESS_V4_OUT"
fi

# ---------- IPv6 egress policy is DROP (ip6tables) ----------
#
# The runner sits on an IPv6 private network; without an ip6tables OUTPUT
# DROP policy, IPv6 egress is unrestricted and bypasses the v4 allowlist.
# We assert the POLICY directly (not a curl -6 probe — a CI runner with no
# IPv6 interface would make a probe falsely pass).
log "IPv6 egress policy: ip6tables OUTPUT policy DROP + AAAA allowlist"
EGRESS_V6_OUT=$(docker run --rm \
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
if echo "$EGRESS_V6_OUT" | grep -q "V6_POLICY_DROP_OK" && echo "$EGRESS_V6_OUT" | grep -q "V6_ACCEPT_OK"; then
  pass "IPv6 egress policy: OUTPUT policy DROP + AAAA ACCEPT present"
else
  fail "IPv6 egress policy" "$EGRESS_V6_OUT"
fi

# ---------- Resolved private IPs are NOT ACCEPT'd (DNS rebinding) ----------
#
# An allowed_host whose DNS resolves to a private/link-local IP must be
# skipped (DNS-rebinding defense). A bind-mounted stub /etc/hosts makes the
# name resolve to those addresses, without changing the image.
log "private-IP filter: resolved private IP refused (DNS-rebinding defense)"
REBIND_HOSTS=$(mktemp)
printf "169.254.169.254 rebind.test\nfd00::1 rebind.test\n" > "$REBIND_HOSTS"
REBIND_OUT=$(docker run --rm \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  -v "$REBIND_HOSTS":/etc/hosts:ro \
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
rm -f "$REBIND_HOSTS"
if echo "$REBIND_OUT" | grep -q "PRIVATE_FILTERED_OK"; then
  pass "private-IP filter: 169.254.169.254 (rebind) refused"
else
  fail "private-IP filter" "$REBIND_OUT"
fi

# ---------- Runner RPC requires the Bearer token ----------
#
# When RUNNER_RPC_TOKEN is set (injected per-run by the api-server), every RPC
# except /healthz must carry the matching Bearer. We boot the real runner and
# probe it. The middleware runs before the route handler, so a missing/wrong
# token yields 401 before any dispatch.
log "RPC auth: runner RPC rejects a missing/wrong token (open /healthz)"
RPC_AUTH_OUT=$(docker run --rm \
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
if echo "$RPC_AUTH_OUT" | grep -q "RPC_AUTH_OK"; then
  pass "RPC auth: /healthz open, /tool 401 without/wrong token, passes with token"
else
  fail "RPC auth" "$RPC_AUTH_OUT"
fi

# ---------- Runner RPC open when RUNNER_RPC_TOKEN unset (back-compat) ----------
log "RPC back-compat: runner RPC open when no token is configured"
RPC_OPEN_OUT=$(docker run --rm \
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
if echo "$RPC_OPEN_OUT" | grep -q "RPC_OPEN_OK"; then
  pass "RPC back-compat: unset RUNNER_RPC_TOKEN → RPC open"
else
  fail "RPC back-compat" "$RPC_OPEN_OUT"
fi

# ---------- ip6tables allows ICMPv6 (Neighbor Discovery) ----------
#
# IPv6 needs ICMPv6/ND to resolve the next-hop for EVERY unicast; under
# ip6tables OUTPUT DROP without an ipv6-icmp ACCEPT, no IPv6 packet leaves
# (RPC reply, DNS, and allowed_hosts all silently fail — the boot-probe bug).
# Assert the rule is accepted by the image netfilter and shows in OUTPUT.
log "ICMPv6: ip6tables ICMPv6 ACCEPT (Neighbor Discovery mandatory under OUTPUT DROP)"
ICMP6_OUT=$(docker run --rm \
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
if echo "$ICMP6_OUT" | grep -q "ICMP6_OK"; then
  pass "ICMPv6: ipv6-icmp ACCEPT present (ND works under OUTPUT DROP)"
else
  fail "ICMPv6" "$ICMP6_OUT"
fi

# ---------- Infra hosts trust-exempt from the private-IP filter ----------
#
# RUNNER_INFRA_HOSTS (object store + install registries) are harness-controlled
# and trusted, so — unlike agent allowed_hosts — they are ACCEPT'd even when
# they resolve to a private address (a self-host MinIO endpoint may be private).
# Mirror the entrypoint infra loop with a stub /etc/hosts resolving to private
# v4 + v6 and assert BOTH are ACCEPT'd (no private-IP skip).
log "infra trust-exempt: infra hosts ACCEPT'd on both families incl. private"
INFRA_HOSTS_FILE=$(mktemp)
printf "10.0.0.5 infra.test\nfd00::5 infra.test\n" > "$INFRA_HOSTS_FILE"
INFRA_OUT=$(docker run --rm \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  -v "$INFRA_HOSTS_FILE":/etc/hosts:ro \
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
rm -f "$INFRA_HOSTS_FILE"
if echo "$INFRA_OUT" | grep -q "INFRA_TRUST_OK"; then
  pass "infra trust-exempt: private infra IP ACCEPT'd on v4+v6 (no private-IP skip)"
else
  fail "infra trust-exempt" "$INFRA_OUT"
fi

# ---------- Harness-6PN RPC reply rule (defense-in-depth) ----------
#
# When RUNNER_HARNESS_6PN is set, the shipped setup_iptables adds an explicit
# ip6tables ACCEPT towards the harness — defense-in-depth behind
# ESTABLISHED,RELATED for the runner's RPC replies, so TCP from the runner's port
# only, and never a lone SYN. Assert the rule it installs, and that no rule accepts
# the address whole. (What the agent's code can reach through it is probed on a
# live runner below.)
log "harness rule: harness-6PN RPC reply rule present when RUNNER_HARNESS_6PN set, and nothing wider"
HARNESS_RULE_OUT=$(docker run --rm \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  -e RUNNER_HARNESS_6PN=fdaa:0:dead::2 \
  -e RUNNER_PORT=9000 \
  --entrypoint /bin/bash \
  "$IMAGE" -c '
    source /usr/local/bin/net-lib.sh
    setup_iptables >/dev/null 2>&1 || { echo "SETUP_FAILED" >&2; exit 72; }
    rules=$(ip6tables -S OUTPUT)
    if grep -qx -- "-A OUTPUT -d fdaa:0:dead::2/128 -j ACCEPT" <<< "$rules"; then
      echo "HARNESS_OPEN: $(grep -- fdaa:0:dead::2 <<< "$rules")" >&2; exit 73
    fi
    if grep -qx -- "-A OUTPUT -d fdaa:0:dead::2/128 -p tcp -m tcp --sport 9000 ! --tcp-flags FIN,SYN,RST,ACK SYN -j ACCEPT" <<< "$rules"; then
      echo "HARNESS_OK"
    else
      echo "HARNESS_MISSING: $(grep -- fdaa:0:dead::2 <<< "$rules")" >&2; exit 71
    fi
  ' 2>&1)
if echo "$HARNESS_RULE_OUT" | grep -q "HARNESS_OK"; then
  pass "harness rule: ip6tables ACCEPTs TCP from the runner's port to the harness 6PN, never a lone SYN, nothing wider (defense-in-depth)"
else
  fail "harness rule" "$HARNESS_RULE_OUT"
fi

# ---------- dns-reresolve state seed → no duplicate re-add ----------
#
# entrypoint.sh seeds /run/skrun-allowed-ips with the boot host|ip pairs so
# dns-reresolve's first diff is empty (no duplicate rule that a later -D would
# leave as a ghost ACCEPT). Assert: the seed is non-empty AND a fresh snapshot
# built the same way diffs to nothing (comm -23 empty).
log "state seed: STATE_FILE seed non-empty + first re-resolve cycle re-adds nothing"
SEED_HOSTS=$(mktemp)
printf "93.184.216.34 seed.test\n" > "$SEED_HOSTS"
SEED_OUT=$(docker run --rm \
  --cap-add NET_ADMIN \
  --security-opt no-new-privileges:true \
  -v "$SEED_HOSTS":/etc/hosts:ro \
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
rm -f "$SEED_HOSTS"
if echo "$SEED_OUT" | grep -q "NO_DUP_OK"; then
  pass "state seed: non-empty + first re-resolve re-adds nothing (no ghost ACCEPT)"
else
  fail "state seed" "$SEED_OUT"
fi

# ---------- Egress diagnostic gated behind RUNNER_EGRESS_DEBUG ----------
#
# The post-boot ip6tables-counter dump must be opt-in (off by default) so a
# normal run has zero diagnostic noise. Assert the SHIPPED entrypoint gates it
# behind RUNNER_EGRESS_DEBUG (the ungated draft would not).
log "diag gate: shipped entrypoint gates the egress diagnostic behind RUNNER_EGRESS_DEBUG"
DIAG_OUT=$(probe diag-gate 'grep -q RUNNER_EGRESS_DEBUG /entrypoint.sh && echo DIAG_GATE_OK')
if echo "$DIAG_OUT" | grep -q "DIAG_GATE_OK"; then
  pass "diag gate: entrypoint diagnostic is opt-in via RUNNER_EGRESS_DEBUG"
else
  fail "diag gate" "$DIAG_OUT"
fi

# ---------- Read-only rootfs (EROFS on write outside tmpfs) ----------
log "read-only rootfs: touch /etc/test must fail with EROFS"
ROOTFS_OUT=$(probe rootfs '
  if touch /etc/test 2>&1; then
    echo "ROOTFS_WRITABLE_LEAK"; exit 21
  fi
  echo "ROOTFS_RO_OK"
')
if echo "$ROOTFS_OUT" | grep -q "ROOTFS_RO_OK"; then
  pass "read-only rootfs: touch /etc/test refused"
else
  fail "read-only rootfs" "$ROOTFS_OUT"
fi

# ---------- Non-root UID 1000 ----------
log "non-root UID: process runs as uid 1000 (skrun-runner)"
UID_OUT=$(probe uid 'id -u; id -n -u')
if echo "$UID_OUT" | head -1 | grep -qE "^1000$"; then
  pass "non-root UID: id -u = 1000"
else
  fail "non-root UID" "got: $UID_OUT (expected uid 1000)"
fi

# ---------- Zero capabilities at user-code level ----------
#
# After capsh handoff (runner mode), Current capability set is empty:
# `capsh --print` shows `Current: =`. We probe directly via cap_drop ALL
# without ever adding any back, mirroring the post-handoff state.
log "zero caps: capsh --print shows Current: ="
CAPS_OUT=$(probe caps 'capsh --print 2>&1 | grep "^Current:"')
if echo "$CAPS_OUT" | grep -qE "^Current:\s*=?\s*$"; then
  pass "zero caps: Current: = (no capabilities)"
else
  fail "zero caps" "got: $CAPS_OUT (expected empty Current: set)"
fi

# ---------- Env scan reveals no credentials ----------
#
# An attacker who lands code execution in the sandbox must NOT find any
# of the harness credentials by reading env. We pass NO secrets at boot
# and assert env contains none of the listed shapes. Even if the operator
# misconfigures and tries to leak via env, the buildMachineConfig env
# allowlist (asserted separately in machine-config.test.ts) refuses.
log "env scan: finds NO credentials"
ENV_OUT=$(probe env-scan 'env | sort')
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
ENV_LEAKS=""
for pat in "${FORBIDDEN_PATTERNS[@]}"; do
  if echo "$ENV_OUT" | grep -q "$pat"; then
    ENV_LEAKS+="$pat "
  fi
done
if [[ -z "$ENV_LEAKS" ]]; then
  pass "env scan: no credentials present (10 patterns checked)"
else
  fail "env scan" "leaked patterns: $ENV_LEAKS"
fi

# ---------- Setuid binary escalation refused ----------
#
# `no-new-privileges` prevents setuid bits from elevating. We test via
# a known setuid binary if any is left in the image (e.g. /usr/bin/sudo
# wouldn't be installed but if it were, running it as a non-root user
# would fail with EPERM under no-new-privileges). The image ships no
# setuid binaries by design; we instead assert the bit-stripping
# `cap-prctl` shows NoNewPrivs: 1.
log "no-new-privileges: enforced (prevents setuid escalation)"
NNP_OUT=$(probe no-new-privs 'cat /proc/self/status | grep NoNewPrivs')
if echo "$NNP_OUT" | grep -qE "NoNewPrivs:\s*1"; then
  pass "no-new-privileges: NoNewPrivs:1 (setuid bits ineffective)"
else
  fail "no-new-privileges" "got: $NNP_OUT (expected NoNewPrivs:1)"
fi

# ---------- mount() syscall refused ----------
#
# Without CAP_SYS_ADMIN (which is in the dropped set), mount() returns
# EPERM. Probe by attempting a tmpfs mount inside a fresh dir.
log "mount() refused: no CAP_SYS_ADMIN"
MOUNT_OUT=$(probe mount '
  mkdir -p /tmp/probe-mount
  if mount -t tmpfs none /tmp/probe-mount 2>&1; then
    echo "MOUNT_LEAKED"; exit 51
  fi
  echo "MOUNT_EPERM_OK"
')
if echo "$MOUNT_OUT" | grep -q "MOUNT_EPERM_OK"; then
  pass "mount() refused: EPERM as expected (no CAP_SYS_ADMIN)"
else
  fail "mount() refused" "$MOUNT_OUT"
fi

# ---------- The shipped egress setup, booted for real ----------
#
# The cases above rebuild a rule or two in bash to assert it in isolation. The ones
# below boot the image's own entrypoint in runner mode — the function that ships,
# with nothing re-implemented — and probe the machine as root through docker exec.
# They run on an IPv6-enabled Docker network: without an IPv6 address in the
# container, getent returns no AAAA and an IPv6 probe has no route, so the IPv6
# half of the rules could not be exercised at all.
#
# Stub names, through --add-host: infra.test is an infrastructure host on a
# private address of each family (as a self-hosted object store may be);
# agent6.test is an agent host with a public IPv6 address.
EGRESS_NET="zt-egress-$$"
EGRESS_CONTAINERS=()
EGRESS_READY=0
cleanup_egress() {
  for c in "${EGRESS_CONTAINERS[@]:-}"; do [[ -n "$c" ]] && docker rm -f "$c" >/dev/null 2>&1; done
  docker network rm "$EGRESS_NET" >/dev/null 2>&1 || true
}
trap cleanup_egress EXIT
if docker network create --ipv6 "$EGRESS_NET" >/dev/null 2>&1; then
  EGRESS_READY=1
else
  log "could not create an IPv6 Docker network — the egress cases below fail"
fi

# boot_egress_runner <name> <allowed hosts CSV> [<harness address>] [outlive] — runner
# mode, the shipped entrypoint; returns once the egress setup has written its boot
# marker. The runner is the process the image's init waits for: when it ends, the
# container stops. With "outlive", a shell sits between the init and the entrypoint
# and stays once the runner has ended, so that a case can stop the runner and still
# probe the machine.
boot_egress_runner() {
  local name="$1" hosts="$2" harness="${3:-fdaa:0:dead::2}" outlive="${4:-}"
  local -a entry=() command=()
  if [[ "$outlive" == outlive ]]; then
    entry=(--entrypoint /usr/bin/tini)
    command=(-- /bin/bash -c '/entrypoint.sh; exec sleep infinity')
  fi
  [[ "$EGRESS_READY" -eq 1 ]] || return 1
  EGRESS_CONTAINERS+=("$name")
  docker run -d --name "$name" --network "$EGRESS_NET" --cap-add NET_ADMIN "${entry[@]}" \
    --add-host "infra.test:192.168.77.7" --add-host "infra.test:fd00:77::7" \
    --add-host "agent6.test:2001:4860:4860::8888" \
    -e SKRUN_CONTAINER_MODE=runner \
    -e SKRUN_ALLOWED_HOSTS="$hosts" \
    -e RUNNER_INFRA_HOSTS=infra.test \
    -e RUNNER_HARNESS_6PN="$harness" \
    -e RUNNER_PORT=9000 \
    "$IMAGE" "${command[@]}" >/dev/null 2>&1 || return 1
  for _ in $(seq 1 60); do
    docker exec "$name" test -f /tmp/skrun-boot.json 2>/dev/null && return 0
    [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" == "true" ]] || return 1
    sleep 0.5
  done
  return 1
}

# drop_count <iptables|ip6tables> <container> <range> — packets counted so far by
# the DROP rule whose destination is <range>; empty when there is no such rule.
drop_count() {
  docker exec "$2" "$1" -L OUTPUT -v -n -x 2>/dev/null |
    awk -v r="$3" '$3 == "DROP" && $NF == r { print $1; exit }'
}

# accept_count <iptables|ip6tables> <container> <address> — same, for the ACCEPT
# rule of one address.
accept_count() {
  docker exec "$2" "$1" -L OUTPUT -v -n -x 2>/dev/null |
    awk -v r="$3" '$3 == "ACCEPT" && ($NF == r || $NF == r "/32" || $NF == r "/128") { print $1; exit }'
}

# probe_blocked <container> <range> <address> <4|6> — the address is not reached,
# AND the DROP of its range counted the attempt. An unrouted address also fails
# to connect; only the counter says the rule did it.
probe_blocked() {
  local c="$1" range="$2" addr="$3" fam="$4" tool=iptables url before after
  [[ "$fam" == 6 ]] && tool=ip6tables
  url="http://$addr/"
  [[ "$fam" == 6 ]] && url="http://[$addr]/"
  before=$(drop_count "$tool" "$c" "$range")
  if docker exec "$c" curl "-$fam" -s -o /dev/null -m 3 "$url"; then
    echo "$addr reached"
    return 1
  fi
  after=$(drop_count "$tool" "$c" "$range")
  if [[ -z "$before" || -z "$after" ]]; then
    echo "$addr not reached, but there is no DROP rule for $range"
    return 1
  fi
  if [[ "$after" -le "$before" ]]; then
    echo "$addr not reached, but the DROP of $range did not count it ($before -> $after)"
    return 1
  fi
  echo "$addr dropped by $range ($before -> $after)"
}

# order_verdict <iptables|ip6tables> <container> <infra address> <agent addresses>
#               [<label>=<ERE of a rule that must precede the first DROP>]...
# The relative order the security rests on: last infrastructure ACCEPT < first
# blocked-range DROP < first ACCEPT of an agent host, read from `-S OUTPUT`.
order_verdict() {
  local tool="$1" c="$2" infra="$3" agents="$4" suffix=/32 rules first_drop last_infra first_agent line a spec
  shift 4
  [[ "$tool" == ip6tables ]] && suffix=/128
  rules=$(docker exec "$c" "$tool" -S OUTPUT 2>&1)
  first_drop=$(grep -n -E -- '^-A OUTPUT -d [^ ]+ -j DROP$' <<< "$rules" | head -1 | cut -d: -f1)
  last_infra=$(grep -n -F -x -- "-A OUTPUT -d $infra$suffix -j ACCEPT" <<< "$rules" | tail -1 | cut -d: -f1)
  first_agent=""
  for a in $agents; do
    line=$(grep -n -F -x -- "-A OUTPUT -d $a$suffix -j ACCEPT" <<< "$rules" | head -1 | cut -d: -f1)
    if [[ -n "$line" ]] && [[ -z "$first_agent" || "$line" -lt "$first_agent" ]]; then first_agent="$line"; fi
  done
  local facts="$tool: last infra ACCEPT ${last_infra:-none}, first DROP ${first_drop:-none}, first agent ACCEPT ${first_agent:-none}"
  if [[ -z "$last_infra" || -z "$first_drop" || -z "$first_agent" ]] ||
    [[ "$last_infra" -ge "$first_drop" || "$first_drop" -ge "$first_agent" ]]; then
    echo "$facts — not in that order"
    return 1
  fi
  for spec in "$@"; do
    line=$(grep -n -E -- "${spec#*=}" <<< "$rules" | tail -1 | cut -d: -f1)
    if [[ -z "$line" || "$line" -ge "$first_drop" ]]; then
      echo "$facts; ${spec%%=*} at ${line:-none}, not before the first DROP"
      return 1
    fi
    facts+="; ${spec%%=*} $line"
  done
  echo "$facts"
}

# counter_verdict <iptables|ip6tables> <container> <range> <address in it> <agent addresses>
# An ACCEPT for a blocked address, placed where the agent's own rules sit — what a
# host filter that failed would produce — must lose to the DROP of its range: the
# probe raises the DROP's counter, never the ACCEPT's.
counter_verdict() {
  local tool="$1" c="$2" range="$3" addr="$4" agents="$5" suffix=/32 fam=4 url rules pos=""
  local line a d0 d1 a0 a1
  [[ "$tool" == ip6tables ]] && { suffix=/128; fam=6; }
  rules=$(docker exec "$c" "$tool" -S OUTPUT 2>&1)
  for a in $agents; do
    line=$(grep -n -F -x -- "-A OUTPUT -d $a$suffix -j ACCEPT" <<< "$rules" | head -1 | cut -d: -f1)
    if [[ -n "$line" ]] && [[ -z "$pos" || "$line" -lt "$pos" ]]; then pos="$line"; fi
  done
  [[ -n "$pos" ]] || { echo "$tool: no agent ACCEPT to stand beside"; return 1; }
  # `-S` line 1 is the policy, so rule number = line - 1.
  docker exec "$c" "$tool" -I OUTPUT $((pos - 1)) -d "$addr" -j ACCEPT ||
    { echo "$tool: could not insert the ACCEPT for $addr"; return 1; }
  url="http://$addr/"
  [[ "$fam" == 6 ]] && url="http://[$addr]/"
  d0=$(drop_count "$tool" "$c" "$range"); a0=$(accept_count "$tool" "$c" "$addr")
  if docker exec "$c" curl "-$fam" -s -o /dev/null -m 3 "$url"; then
    echo "$tool: $addr was reached"
    return 1
  fi
  d1=$(drop_count "$tool" "$c" "$range"); a1=$(accept_count "$tool" "$c" "$addr")
  local facts="$tool: $addr — DROP $range ${d0:-none} -> ${d1:-none}, its ACCEPT ${a0:-none} -> ${a1:-none}"
  if [[ -z "$d0" || -z "$d1" || -z "$a0" || -z "$a1" ]] || [[ "$d1" -le "$d0" || "$a1" -ne "$a0" ]]; then
    echo "$facts — the DROP did not take it"
    return 1
  fi
  echo "$facts"
}

log "egress '*': the shipped entrypoint, allowed_hosts '*'"
STAR="zt-star-$$"
if boot_egress_runner "$STAR" "*"; then
  if docker exec "$STAR" curl -4 -s -o /dev/null -m 10 https://example.com; then
    pass "egress '*': a public host (example.com) is reached"
  else
    fail "egress '*': public host" "example.com was not reached under '*'"
  fi

  STAR_V4=""
  for target in "10.0.0.0/8 10.0.0.1" "198.18.0.0/15 198.18.0.1"; do
    read -r range addr <<< "$target"
    if out=$(probe_blocked "$STAR" "$range" "$addr" 4); then STAR_V4+="$out; "; else STAR_V4="FAIL $out"; break; fi
  done
  if [[ "$STAR_V4" != FAIL* ]]; then
    pass "egress '*': a private and a reserved literal refused by their range — $STAR_V4"
  else
    fail "egress '*': private and reserved literals" "$STAR_V4"
  fi

  SMTP_OUT=$(docker exec "$STAR" python3 -c '
import socket, sys, time
addr = socket.getaddrinfo("example.com", 25, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
start = time.time()
try:
    socket.create_connection((addr, 25), timeout=5).close()
    print("CONNECTED", addr)
except ConnectionRefusedError:
    print("RESET", addr, round(time.time() - start, 3))
except Exception as err:
    print("OTHER", addr, type(err).__name__, round(time.time() - start, 3))
' 2>&1)
  if [[ "$SMTP_OUT" == RESET* ]] && awk '{ exit !($3 < 2) }' <<< "$SMTP_OUT"; then
    pass "egress '*': TCP/25 to a public host is reset at once ($SMTP_OUT s)"
  else
    fail "egress '*': TCP/25" "expected an immediate reset, got: $SMTP_OUT"
  fi

  V6_RULES=$(docker exec "$STAR" ip6tables -S OUTPUT 2>&1)
  INFRA6=$(grep -n -- '-d fd00:77::7/128 -j ACCEPT' <<< "$V6_RULES" | tail -1 | cut -d: -f1)
  ULA_DROP=$(grep -n -- '-d fc00::/7 -j DROP' <<< "$V6_RULES" | head -1 | cut -d: -f1)
  MC_DROP=$(grep -n -- '-d ff00::/8 -j DROP' <<< "$V6_RULES" | head -1 | cut -d: -f1)
  if [[ -n "$INFRA6" && -n "$ULA_DROP" && -n "$MC_DROP" && "$INFRA6" -lt "$ULA_DROP" && "$INFRA6" -lt "$MC_DROP" ]]; then
    pass "egress '*': IPv6 DROPs fc00::/7 and ff00::/8 present, after the infrastructure ACCEPT (lines $INFRA6 < $ULA_DROP, $MC_DROP)"
  else
    fail "egress '*': IPv6 drops" "infra=${INFRA6:-none} fc00::/7=${ULA_DROP:-none} ff00::/8=${MC_DROP:-none}: $V6_RULES"
  fi
else
  fail "egress '*'" "the runner did not boot: $(docker logs "$STAR" 2>&1 | tail -20)"
fi

log "egress, named hosts: the shipped entrypoint, allowed_hosts 'example.com,agent6.test'"
NAMED="zt-named-$$"
if boot_egress_runner "$NAMED" "example.com,agent6.test"; then
  NAMED_RULES=$(docker exec "$NAMED" iptables -S OUTPUT 2>&1)
  NAMED_OUT=""
  docker exec "$NAMED" curl -4 -s -o /dev/null -m 10 https://example.com || NAMED_OUT+="example.com not reached; "
  docker exec "$NAMED" curl -4 -s -o /dev/null -m 3 http://1.1.1.1/ && NAMED_OUT+="undeclared 1.1.1.1 reached; "
  grep -qx -- '-A OUTPUT -j ACCEPT' <<< "$NAMED_RULES" && NAMED_OUT+="a catch-all ACCEPT exists; "
  grep -q -- '--dport 25' <<< "$NAMED_RULES" && NAMED_OUT+="a TCP/25 rule exists; "
  if [[ -z "$NAMED_OUT" ]]; then
    pass "egress, named host: example.com reached, an undeclared address blocked, no catch-all, no TCP/25 rule"
  else
    fail "egress, named host" "$NAMED_OUT"
  fi

  # Why a blocked address is refused, not only that it is: the relative order of
  # the rules, on both families. The agent's addresses are the ones its boot loop
  # recorded for the re-resolve loop.
  AGENT_V4=$(docker exec "$NAMED" cat /run/skrun-allowed-ips 2>/dev/null | cut -d'|' -f2 | grep -v ':' | tr '\n' ' ')
  AGENT_V6=$(docker exec "$NAMED" cat /run/skrun-allowed-ips 2>/dev/null | cut -d'|' -f2 | grep ':' | tr '\n' ' ')
  O4=$(order_verdict iptables "$NAMED" 192.168.77.7 "$AGENT_V4" "DNS=--dport 53 -j ACCEPT$"); R4=$?
  O6=$(order_verdict ip6tables "$NAMED" fd00:77::7 "$AGENT_V6" \
    "ICMPv6=^-A OUTPUT -p ipv6-icmp -j ACCEPT$" "harness=^-A OUTPUT -d fdaa:0:dead::2/128 -p tcp -m tcp --sport 9000 ! --tcp-flags FIN,SYN,RST,ACK SYN -j ACCEPT$"); R6=$?
  if [[ "$R4" -eq 0 && "$R6" -eq 0 ]]; then
    pass "egress order: infrastructure < blocked-range DROPs < agent hosts, on both families ($O4 | $O6)"
  else
    fail "egress order" "$O4 | $O6"
  fi

  C4=$(counter_verdict iptables "$NAMED" 10.0.0.0/8 10.0.0.5 "$AGENT_V4"); R4=$?
  C6=$(counter_verdict ip6tables "$NAMED" fc00::/7 fd00::5 "$AGENT_V6"); R6=$?
  if [[ "$R4" -eq 0 && "$R6" -eq 0 ]]; then
    pass "egress order: an ACCEPT for a blocked address beside the agent's loses to its range's DROP ($C4 | $C6)"
  else
    fail "egress order, counters" "$C4 | $C6"
  fi
else
  fail "egress, named host" "the runner did not boot: $(docker logs "$NAMED" 2>&1 | tail -20)"
fi

# ---------- The harness: only the runner's RPC replies go back to it ----------
#
# RUNNER_HARNESS_6PN is the control plane's address. The sandbox's one rule towards
# it lets out the replies of the runner's RPC server — TCP from the port the runner
# listens on — and nothing else: the agent's code must not open a connection to the
# harness, on any port, while the harness still drives the runner. A witness
# container plays the harness on the IPv6 network: its address is the one the runner
# is given, and it serves a port that is not the runner's.
HARNESS="zt-harness-$$"
HARNESS_PORT=4000

# blocked_range_of <container> <address> — the first blocked range holding the
# address, read from the image's list: the DROP that should take an attempt on it.
blocked_range_of() {
  docker exec "$1" python3 -c '
import ipaddress, sys
addr = ipaddress.ip_address(sys.argv[1])
for line in open("/usr/local/share/skrun/blocked-ranges"):
    net = ipaddress.ip_network(line.strip()) if line.strip() else None
    if net is not None and net.version == addr.version and addr in net:
        print(net)
        break
' "$2" 2>/dev/null
}

# harness_rule_count <container> — packets counted so far by the ACCEPT rules whose
# destination is the harness, read with their counters (`-S -v`).
harness_rule_count() {
  docker exec "$1" ip6tables -v -S OUTPUT 2>/dev/null |
    awk -v d="-d $HARNESS_ADDR/128" 'index($0, d) && / -j ACCEPT$/ {
      for (i = 1; i < NF; i++) if ($i == "-c") n += $(i + 1)
    } END { print n + 0 }'
}

# healthz_from_harness <container> — the harness drives the runner: its /healthz,
# from the witness, once the runner listens. The reply leaves through the rules
# under test. Prints the HTTP code.
healthz_from_harness() {
  local addr
  addr=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.GlobalIPv6Address}}{{end}}' "$1")
  for _ in $(seq 1 40); do
    docker exec "$HARNESS" curl -6 -s -o /dev/null -m 2 "http://[$addr]:9000/healthz" && break
    sleep 0.25
  done
  docker exec "$HARNESS" curl -6 -s -o /dev/null -w '%{http_code}' -m 5 "http://[$addr]:9000/healthz" 2>/dev/null
}

log "egress, harness: the agent's code cannot reach the harness on port $HARNESS_PORT; the harness still reaches the runner"
EGRESS_CONTAINERS+=("$HARNESS")
HARNESS_ADDR=""
if [[ "$EGRESS_READY" -eq 1 ]] &&
  docker run -d --name "$HARNESS" --network "$EGRESS_NET" --entrypoint python3 "$IMAGE" \
    -m http.server "$HARNESS_PORT" --bind :: >/dev/null 2>&1; then
  HARNESS_ADDR=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.GlobalIPv6Address}}{{end}}' "$HARNESS" 2>/dev/null)
fi
TOWARDS="zt-towards-$$"
if [[ -z "$HARNESS_ADDR" ]]; then
  fail "egress, harness" "the witness harness has no IPv6 address on the test network"
elif ! boot_egress_runner "$TOWARDS" "*" "$HARNESS_ADDR"; then
  fail "egress, harness" "the runner did not boot: $(docker logs "$TOWARDS" 2>&1 | tail -20)"
else
  # The DROP that should take the attempt: the first blocked range holding the
  # harness's address (on Fly, a unique-local address; here, Docker's).
  H_RANGE=$(blocked_range_of "$TOWARDS" "$HARNESS_ADDR")
  RPC_CODE=$(healthz_from_harness "$TOWARDS")
  D0=$(drop_count ip6tables "$TOWARDS" "${H_RANGE:-none}"); A0=$(harness_rule_count "$TOWARDS")
  if docker exec -u 1000 "$TOWARDS" curl -6 -s -o /dev/null -m 3 "http://[$HARNESS_ADDR]:$HARNESS_PORT/"; then
    REACHED=yes
  else
    REACHED=no
  fi
  D1=$(drop_count ip6tables "$TOWARDS" "${H_RANGE:-none}"); A1=$(harness_rule_count "$TOWARDS")
  H_FACTS="harness [$HARNESS_ADDR]:$HARNESS_PORT reached=$REACHED; DROP ${H_RANGE:-none} ${D0:-none} -> ${D1:-none}; harness rule ${A0} -> ${A1}; /healthz from the harness: ${RPC_CODE:-none}"
  if [[ "$REACHED" == no && -n "$D0" && -n "$D1" && "$D1" -gt "$D0" && "$A1" -eq "$A0" && "$RPC_CODE" == 200 ]]; then
    pass "egress, harness: the agent's code is refused, by the DROP of the harness's range, and the harness reaches the runner ($H_FACTS)"
  else
    fail "egress, harness" "$H_FACTS — expected: not reached, the DROP counting it, the harness rule counting nothing, /healthz 200"
  fi
fi

# ---------- The harness: no new connection from the runner's own port ----------
#
# The agent's code runs as the runner's user: it can stop the runner, take the port
# the runner listened on and open a connection to the harness from there — TCP from
# that port, which a rule on the source port alone lets out. A reply never starts
# with a lone SYN, and the rule takes none. The runner is stopped here, so the case
# has its own container, whose shell outlives the runner. The new connection is
# opened by a socket that may reuse the port the runner has just left.
TAKEOVER="zt-takeover-$$"
log "egress, harness: once the runner is stopped, a connection from its own port still cannot reach the harness"
if [[ -z "$HARNESS_ADDR" ]]; then
  fail "egress, harness from the runner's port" "the witness harness has no IPv6 address on the test network"
elif ! boot_egress_runner "$TAKEOVER" "*" "$HARNESS_ADDR" outlive; then
  fail "egress, harness from the runner's port" "the runner did not boot: $(docker logs "$TAKEOVER" 2>&1 | tail -20)"
else
  T_RANGE=$(blocked_range_of "$TAKEOVER" "$HARNESS_ADDR")
  T_RPC=$(healthz_from_harness "$TAKEOVER")
  # As the runner's user: stop the runner, then wait until it is gone.
  docker exec -u 1000 "$TAKEOVER" pkill -KILL -u 1000 -f 'node /opt/skrun-runner/dist/index.js' >/dev/null 2>&1
  T_STOPPED=no
  for _ in $(seq 1 40); do
    if ! docker exec "$TAKEOVER" pgrep -f 'node /opt/skrun-runner/dist/index.js' >/dev/null 2>&1; then
      T_STOPPED=yes
      break
    fi
    sleep 0.25
  done
  D0=$(drop_count ip6tables "$TAKEOVER" "${T_RANGE:-none}"); A0=$(harness_rule_count "$TAKEOVER")
  T_CONNECT=$(docker exec -u 1000 "$TAKEOVER" python3 -c '
import socket, sys
s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("::", int(sys.argv[2])))
s.settimeout(3)
try:
    s.connect((sys.argv[1], int(sys.argv[3])))
    print("reached")
except OSError as exc:
    print("not reached: %s" % exc)
' "$HARNESS_ADDR" 9000 "$HARNESS_PORT" 2>&1)
  D1=$(drop_count ip6tables "$TAKEOVER" "${T_RANGE:-none}"); A1=$(harness_rule_count "$TAKEOVER")
  T_FACTS="runner stopped=$T_STOPPED; from port 9000 to [$HARNESS_ADDR]:$HARNESS_PORT: ${T_CONNECT:-nothing}; DROP ${T_RANGE:-none} ${D0:-none} -> ${D1:-none}; harness rule ${A0} -> ${A1}; /healthz from the harness, before: ${T_RPC:-none}"
  if [[ "$T_STOPPED" == yes && "$T_CONNECT" == "not reached:"* && -n "$D0" && -n "$D1" && "$D1" -gt "$D0" && "$A1" -eq "$A0" && "$T_RPC" == 200 ]]; then
    pass "egress, harness from the runner's port: the runner stopped, a new connection from its port is refused by the DROP of the harness's range, the harness rule counting nothing ($T_FACTS)"
  else
    fail "egress, harness from the runner's port" "$T_FACTS — expected: the runner stopped, not reached, the DROP counting it, the harness rule counting nothing, /healthz 200 before"
  fi
fi

# ---------- The lifetime guardian holds against the agent's own uid ----------
#
# A machine created for a run carries its lifetime (RUNNER_LIFETIME_S). The root
# re-resolve loop arms it at boot, starting the guardian — a root loop of its own,
# which names itself in a log line —, and at the deadline the guardian ends the
# runner — TERM, then KILL — whatever the agent's code did: that code runs as the
# runner's user (1000), which can freeze the runner and cannot signal the guardian.
# The runner is the process the image's init waits for, so its end stops the
# container. A lifetime of a few seconds keeps the case short. The machines that
# must not end — no lifetime, one the loop does not arm, one at the longest a run
# can be given — boot alongside and are read once the armed one has ended.
GUARD_LIFETIME_S=15

# boot_lifetime_runner <name> [docker run option]... — runner mode, the shipped
# entrypoint, a one-second re-resolve cycle. Returns once the container is started.
boot_lifetime_runner() {
  local name="$1"; shift
  EGRESS_CONTAINERS+=("$name")
  docker run -d --name "$name" --cap-add NET_ADMIN \
    -e SKRUN_CONTAINER_MODE=runner -e RUNNER_PORT=9000 -e SKRUN_DNS_RESOLVE_INTERVAL=1 \
    "$@" "$IMAGE" >/dev/null 2>&1
}

# pid_of <container> <pattern> — the oldest process whose command line matches.
pid_of() { docker exec "$1" pgrep -o -f "$2" 2>/dev/null; }

# state_of <container> <pid> — the process's state letter (T: stopped).
state_of() { docker exec "$1" awk '{ print $3 }' "/proc/$2/stat" 2>/dev/null; }

# wait_for_runner <container> — until both the runner and the loop run, or 30 s.
wait_for_runner() {
  for _ in $(seq 1 60); do
    [[ -n "$(pid_of "$1" 'node /opt/skrun-runner/dist/index.js')" && -n "$(pid_of "$1" dns-reresolve)" ]] && return 0
    [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]] || return 1
    sleep 0.5
  done
  return 1
}

# guardian_of <container> — the guardian's pid, as its own log line names it once it
# runs; empty after 10 s without one.
guardian_of() {
  local pid=""
  for _ in $(seq 1 20); do
    pid=$(docker logs "$1" 2>&1 | sed -n 's/.*lifetime_guardian pid=\([0-9][0-9]*\) .*/\1/p' | head -1)
    [[ -n "$pid" ]] && break
    sleep 0.5
  done
  echo "$pid"
}

# await_assignment <container> — until its loop awaits the channel, or 30 s.
await_assignment() {
  for _ in $(seq 1 60); do
    docker logs "$1" 2>&1 | grep -q "awaiting assignment on the channel" && return 0
    [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]] || return 1
    sleep 0.5
  done
  return 1
}

GUARD="zt-guard-$$"
GUARD_LIVE=()
log "lifetime guardian: the agent's uid freezes the runner and cannot signal the guardian; the machine ends at its lifetime"
# The machines that must live on boot first: the armed one's short lifetime then
# starts last, and its runner is frozen well before its deadline.
for spec in "unset|" "zero|0" "letters|12a" "eleven|12345678901" "cap|2148417" "ten|9999999999"; do
  label="${spec%%|*}" value="${spec#*|}"
  name="zt-guard-$label-$$"
  GUARD_LIVE+=("$label|$value|$name")
  if [[ "$label" == unset ]]; then
    boot_lifetime_runner "$name"
  else
    boot_lifetime_runner "$name" -e RUNNER_LIFETIME_S="$value"
  fi
done
boot_lifetime_runner "$GUARD" -e RUNNER_LIFETIME_S="$GUARD_LIFETIME_S"
if ! wait_for_runner "$GUARD"; then
  fail "lifetime guardian" "the runner did not boot: $(docker logs "$GUARD" 2>&1 | tail -20)"
else
  G_RUNNER=$(pid_of "$GUARD" 'node /opt/skrun-runner/dist/index.js')
  G_LOOP=$(guardian_of "$GUARD")
  # As the agent's code would: freeze the runner, then try to stop and kill the guardian.
  G_FREEZE=$(docker exec -u 1000 "$GUARD" bash -c 'kill -STOP "$1" && echo frozen' _ "$G_RUNNER" 2>&1)
  # Its effective capabilities printed with it: the refusal must come from the uid alone.
  G_STOP=$(docker exec -u 1000 "$GUARD" bash -c 'grep CapEff /proc/self/status; kill -STOP "$1"; echo "rc=$?"' _ "$G_LOOP" 2>&1)
  G_KILL=$(docker exec -u 1000 "$GUARD" bash -c 'kill -KILL "$1"; echo "rc=$?"' _ "$G_LOOP" 2>&1)
  G_RUNNER_STATE=$(state_of "$GUARD" "$G_RUNNER")
  G_LOOP_STATE=$(state_of "$GUARD" "$G_LOOP")
  G_ENDED=no
  G_WAITED=0
  for _ in $(seq 1 120); do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$GUARD" 2>/dev/null)" != "true" ]]; then
      G_ENDED=yes
      break
    fi
    sleep 0.5
    G_WAITED=$((G_WAITED + 1))
  done
  G_EXIT=$(docker inspect -f '{{.State.ExitCode}}' "$GUARD" 2>/dev/null)
  G_LOGS=$(docker logs "$GUARD" 2>&1)
  G_FACTS="runner $G_RUNNER: '$G_FREEZE', state ${G_RUNNER_STATE:-none}; guardian ${G_LOOP:-none} as uid 1000: STOP '$(tr '\n' ' ' <<< "$G_STOP")', KILL '$(tr '\n' ' ' <<< "$G_KILL")', state ${G_LOOP_STATE:-none}; ended=$G_ENDED after ~$((G_WAITED / 2)) s of waiting, exit ${G_EXIT:-none}; $(grep -oE 'lifetime_(armed|guardian|reached|kill)[^—]*' <<< "$G_LOGS" | tr '\n' ' ')"
  if [[ "$G_FREEZE" == frozen && "$G_RUNNER_STATE" == T ]] &&
    grep -q "Operation not permitted" <<< "$G_STOP" && grep -q "rc=1" <<< "$G_STOP" &&
    grep -q "Operation not permitted" <<< "$G_KILL" && grep -q "rc=1" <<< "$G_KILL" &&
    [[ -n "$G_LOOP_STATE" && "$G_LOOP_STATE" != T && "$G_ENDED" == yes ]] &&
    grep -q "lifetime_armed from=environment lifetime_s=$GUARD_LIFETIME_S " <<< "$G_LOGS" &&
    grep -q "lifetime_guardian pid=$G_LOOP runner_pid=$G_RUNNER " <<< "$G_LOGS" &&
    grep -q "lifetime_reached runner_pid=$G_RUNNER comm=node " <<< "$G_LOGS" &&
    grep -q "lifetime_kill runner_pid=$G_RUNNER " <<< "$G_LOGS"; then
    pass "lifetime guardian: the agent's uid froze the runner and was refused both signals to the guardian; at its lifetime the guardian ended the frozen runner, TERM then KILL, and the machine stopped ($G_FACTS)"
  else
    fail "lifetime guardian" "$G_FACTS — expected: the runner frozen (T), both signals to the guardian refused (Operation not permitted), the guardian running, the machine stopped after lifetime_armed, lifetime_guardian, lifetime_reached (comm=node) and lifetime_kill"
  fi
fi

# Read once the armed machine has ended, a lifetime plus the kill delay after they
# all booted: each must still run. The ones the loop cannot arm say why; the two at
# the longest lifetimes are armed, their deadline far ahead.
for entry in "${GUARD_LIVE[@]}"; do
  IFS='|' read -r label value name <<< "$entry"
  running=$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)
  logs=$(docker logs "$name" 2>&1)
  case "$label" in
    unset) want="lifetime_invalid from=environment reason=absent" ;;
    zero) want="lifetime_invalid from=environment reason=zero" ;;
    letters | eleven) want="lifetime_invalid from=environment reason=not 1 to 10 digits" ;;
    *) want="lifetime_armed from=environment lifetime_s=$value " ;;
  esac
  facts="running=${running:-none}; $(grep -oE 'lifetime_[a-z]+[^—]*' <<< "$logs" | tr '\n' ' ')"
  if [[ "$label" == cap || "$label" == ten ]]; then
    what="a lifetime of $value s is armed, its deadline far ahead, and the machine does not end at its start"
    ok_extra=$(grep -c "lifetime_reached" <<< "$logs")
  else
    what="RUNNER_LIFETIME_S ${value:-unset} arms nothing, said, starts no guardian, and the machine lives on"
    ok_extra=$(grep -cE "lifetime_(armed|guardian)" <<< "$logs")
  fi
  if [[ "$running" == true && "$ok_extra" -eq 0 ]] && grep -qF -- "$want" <<< "$logs"; then
    pass "lifetime guardian: $what ($facts)"
  else
    fail "lifetime guardian, $label" "$facts — expected: running, '$want'"
  fi
done

# deadline_at <container> — the host's clock, in whole seconds, when the lifetime
# the container armed is reached: its deadline in the machine's uptime, read in its
# log, against the uptime read now. Empty when either is missing.
deadline_at() {
  local up deadline
  up=$(docker exec "$1" cat /proc/uptime 2>/dev/null)
  up=${up%%.*}
  deadline=$(docker logs "$1" 2>&1 | sed -n 's/.*lifetime_armed .* deadline_uptime_s=\([0-9][0-9]*\) .*/\1/p' | head -1)
  [[ "$up" =~ ^[0-9]+$ && -n "$deadline" ]] || return 0
  echo $(($(date +%s) + deadline - up))
}

# lateness_of <logs> — how many seconds past its deadline the guardian found it
# reached, read in its lifetime_reached line; empty without one.
lateness_of() {
  sed -n 's/.*lifetime_reached .* uptime_s=\([0-9][0-9]*\) deadline_uptime_s=\([0-9][0-9]*\) .*/\1 \2/p' <<< "$1" |
    head -1 | awk '{ print $1 - $2 }'
}

# wait_end <container> <host second> — until the container has stopped, or the
# host's clock is past the second given: "yes" or "no", then the second it was seen.
wait_end() {
  while (($(date +%s) <= $2)); do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" != "true" ]]; then
      echo "yes $(date +%s)"
      return 0
    fi
    sleep 0.5
  done
  echo "no $(date +%s)"
}

# ---------- The lifetime guardian holds when the process table is full ----------
#
# The agent's code can fill the machine's process table. No process starts then —
# root's no more than its own —, and a bash script that cannot start one ends: bash
# retries for some 15 s, then exits, whatever follows the command. The re-resolve
# loop is such a script. The guardian starts no process once it runs — it waits on
# the read builtin's timeout, reads the clock and signals with builtins —, so the
# machine still ends at its lifetime. Here the container's task limit stands for
# the table: as the agent's uid, a process takes every free slot and each one that
# frees — a fork bomb that never lets go —, and once the limit is reached it is
# lowered under the tasks running: a slot a task frees is then never one another
# can take, so that no fork succeeds, whoever wins a race for a freed slot (a loop
# that forks again the moment its child exits would win one). The container is
# bounded — tasks, memory, one CPU — and removed with the others: nothing of the
# host's table is taken. Root in a container lacks the capability that lowering an
# OOM score takes: the case gives it, and the guardian puts itself out of the OOM
# killer's reach.
FORK_LIFETIME_S=20
FORK_PIDS_LIMIT=64
# How far under the tasks running the limit is lowered: more than can exit meanwhile.
FORK_PIDS_UNDER=16
FORK="zt-guard-forkbomb-$$"
log "lifetime guardian: the agent's uid fills the process table, root's forks refused too; the machine still ends at its lifetime"
boot_lifetime_runner "$FORK" --pids-limit "$FORK_PIDS_LIMIT" --memory 512m --cpus 1 --cap-add SYS_RESOURCE \
  -e RUNNER_LIFETIME_S="$FORK_LIFETIME_S"
if ! wait_for_runner "$FORK"; then
  fail "lifetime guardian, process table full" "the runner did not boot: $(docker logs "$FORK" 2>&1 | tail -20)"
else
  F_GUARDIAN=$(guardian_of "$FORK")
  F_DEADLINE=$(deadline_at "$FORK")
  # As the agent's code would: a process that takes every free slot, and each one
  # that frees, its children holding theirs.
  docker exec -d -u 1000 "$FORK" python3 -c '
import os, time
while True:
    try:
        child = os.fork()
    except OSError:
        time.sleep(0.005)
        continue
    if child == 0:
        while True:
            time.sleep(3600)' >/dev/null 2>&1
  # Until the limit is reached, then the limit under the tasks running. A process
  # docker exec starts is moved into the container's group, which a full task limit
  # does not refuse: the count is read from inside, and a fork of root's is tried.
  F_TASKS=0
  for _ in $(seq 1 30); do
    F_TASKS=$(docker exec "$FORK" cat /sys/fs/cgroup/pids.current 2>/dev/null)
    [[ "$F_TASKS" =~ ^[0-9]+$ ]] || F_TASKS=0
    ((F_TASKS >= FORK_PIDS_LIMIT)) && break
    sleep 0.5
  done
  F_LIMIT=none
  if ((F_TASKS >= FORK_PIDS_LIMIT)) &&
    docker update --pids-limit $((F_TASKS - FORK_PIDS_UNDER)) "$FORK" >/dev/null 2>&1; then
    F_LIMIT=$((F_TASKS - FORK_PIDS_UNDER))
  fi
  F_ROOT_OUT=$(docker exec "$FORK" sh -c '/bin/true && echo forked' 2>&1)
  F_ROOT="refused: $(head -1 <<< "$F_ROOT_OUT" | cut -c1-160)"
  [[ "$F_ROOT_OUT" == *forked* ]] && F_ROOT="forked"
  # Still running a little before its deadline: whatever ends it, ends it after.
  F_BEFORE=none
  if [[ -n "$F_DEADLINE" ]]; then
    while (($(date +%s) < F_DEADLINE - 3)); do sleep 0.5; done
    F_BEFORE=$(docker inspect -f '{{.State.Running}}' "$FORK" 2>/dev/null)
  fi
  # The kill delay after TERM, and a margin.
  read -r F_ENDED F_SEEN <<< "$(wait_end "$FORK" $((${F_DEADLINE:-0} + 30)))"
  F_LOGS=$(docker logs "$FORK" 2>&1)
  F_LATE=$(lateness_of "$F_LOGS")
  F_FORKS=$(grep -c "fork: " <<< "$F_LOGS")
  F_AFTER=none
  [[ -n "$F_DEADLINE" ]] && F_AFTER=$((F_SEEN - F_DEADLINE))
  F_FACTS="guardian ${F_GUARDIAN:-none}; $F_TASKS tasks, the limit lowered to $F_LIMIT; a fork of root's: $F_ROOT; refused forks in the log: $F_FORKS; running 3 s before the deadline: ${F_BEFORE:-none}; ended=$F_ENDED, seen ${F_AFTER} s after the deadline, reached ${F_LATE:-never} s after it; $(grep -oE 'lifetime_(armed|guardian|reached|kill)[^—]*' <<< "$F_LOGS" | tr '\n' ' ')"
  if [[ -n "$F_GUARDIAN" && "$F_LIMIT" != none && "$F_ROOT" == refused* && "$F_FORKS" -gt 0 ]] &&
    [[ "$F_BEFORE" == true && "$F_ENDED" == yes ]] &&
    [[ -n "$F_LATE" && "$F_LATE" -le 2 ]] &&
    grep -q "lifetime_guardian pid=$F_GUARDIAN .* oom_score_adj=-1000 " <<< "$F_LOGS" &&
    grep -q "lifetime_reached runner_pid=[0-9]* comm=node " <<< "$F_LOGS"; then
    pass "lifetime guardian, process table full: the agent's uid took every slot, a process of root's could not fork, nor could the re-resolve loop; the guardian, out of the OOM killer's reach, ended the runner at its lifetime and the machine stopped ($F_FACTS)"
  else
    fail "lifetime guardian, process table full" "$F_FACTS — expected: the limit reached and lowered, a fork of root's refused, refused forks in the loop's log, the runner running 3 s before the deadline, lifetime_guardian with oom_score_adj=-1000, lifetime_reached (comm=node) within 2 s of the deadline, the machine stopped"
  fi
fi

# ---------- The lifetime guardian does not wait for the hosts' resolutions ----------
#
# Each cycle, the re-resolve loop resolves every host the agent allows; the agent's
# author holds the nameservers of its names, and a list has no bound. Here six
# allowed names, read from /etc/hosts at the boot, are then sent to a nameserver
# that never answers — a cycle of some 48 s, still resolving at the deadline —, and
# the guardian ends the machine at its lifetime all the same.
SLOW_LIFETIME_S=15
SLOW="zt-guard-slow-$$"
SLOW_HOSTS=""
SLOW_ADD=()
for i in 1 2 3 4 5 6; do
  SLOW_HOSTS+="${SLOW_HOSTS:+,}slow$i.test"
  SLOW_ADD+=(--add-host "slow$i.test:93.184.216.$((40 + i))")
done
log "lifetime guardian: a cycle slowed by its hosts' resolutions does not delay the machine's end"
boot_lifetime_runner "$SLOW" "${SLOW_ADD[@]}" -e SKRUN_ALLOWED_HOSTS="$SLOW_HOSTS" -e RUNNER_LIFETIME_S="$SLOW_LIFETIME_S"
if ! wait_for_runner "$SLOW"; then
  fail "lifetime guardian, slow resolutions" "the runner did not boot: $(docker logs "$SLOW" 2>&1 | tail -20)"
else
  S_DEADLINE=$(deadline_at "$SLOW")
  # As root, what an author's names can undergo: gone from /etc/hosts, and sent to a
  # nameserver that takes every query and never answers.
  docker exec "$SLOW" bash -c 'h=$(grep -v "slow[0-9]\.test" /etc/hosts); printf "%s\n" "$h" > /etc/hosts
    printf "nameserver 127.0.0.1\noptions timeout:4 attempts:1\n" > /etc/resolv.conf' >/dev/null 2>&1
  docker exec -d "$SLOW" python3 -c 'import socket, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("127.0.0.1", 53))
time.sleep(600)' >/dev/null 2>&1
  S_RESOLVING=none
  if [[ -n "$S_DEADLINE" ]]; then
    while (($(date +%s) < S_DEADLINE - 2)); do sleep 0.5; done
    S_RESOLVING=$(docker exec "$SLOW" pgrep -c -x getent 2>/dev/null)
  fi
  read -r S_ENDED S_SEEN <<< "$(wait_end "$SLOW" $((${S_DEADLINE:-0} + 25)))"
  S_LOGS=$(docker logs "$SLOW" 2>&1)
  S_LATE=$(lateness_of "$S_LOGS")
  S_AFTER=none
  [[ -n "$S_DEADLINE" ]] && S_AFTER=$((S_SEEN - S_DEADLINE))
  S_FACTS="resolutions running 2 s before the deadline: ${S_RESOLVING:-none}; ended=$S_ENDED, seen ${S_AFTER} s after the deadline, reached ${S_LATE:-never} s after it; $(grep -oE 'lifetime_(armed|guardian|reached|kill)[^—]*' <<< "$S_LOGS" | tr '\n' ' ')"
  if [[ "$S_RESOLVING" =~ ^[0-9]+$ && "$S_RESOLVING" -ge 1 && "$S_ENDED" == yes && -n "$S_LATE" && "$S_LATE" -le 2 ]] &&
    grep -q "lifetime_reached runner_pid=[0-9]* comm=node " <<< "$S_LOGS"; then
    pass "lifetime guardian, slow resolutions: a cycle still resolving its hosts at the deadline, the guardian ended the runner at its lifetime and the machine stopped ($S_FACTS)"
  else
    fail "lifetime guardian, slow resolutions" "$S_FACTS — expected: a resolution running 2 s before the deadline, lifetime_reached (comm=node) within 2 s of the deadline, the machine stopped"
  fi
fi

# ---------- The assignment channel's message: refused or accepted as it is formed ----------
#
# A pre-created machine receives one line on its assignment channel: "<lifetime>;
# <hosts>", or, in the older form, the hosts alone. The loop refuses any other line
# before installing anything, and accepts a lifetime it does not arm — empty, zero,
# past ten digits — arming nothing and saying so. The runner never writes a malformed
# line, so each line is written here as root, straight into the channel: what is
# under test is the loop's own reading. p9.test resolves to a public address.
P9_ADDR=93.184.216.34
P9_CLAIM="claim-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"

# channel_line <container> <line> — writes the line into the channel and prints the
# loop's one-word answer, read on the other end, opened first.
channel_line() {
  docker exec "$1" bash -c '
    exec 5<> /run/skrun-egress/ack || { echo "(no channel)"; exit 0; }
    printf "%s\n" "$1" > /run/skrun-egress/request
    read -r -t 10 reply <&5 || reply="(no answer)"
    echo "$reply"' _ "$2" 2>&1
}

P9_CASES=(
  "letters|abc;p9.test|REFUSED|none|"
  "sign|-5;p9.test|REFUSED|none|"
  "empty|;p9.test|OK|rule|reason=absent"
  "zero|0;p9.test|OK|rule|reason=zero"
  "eleven|12345678901;p9.test|OK|rule|reason=not 1 to 10 digits"
  "older|p9.test|OK|rule|reason=absent"
)
log "assignment channel: a malformed line is refused with no rule; a lifetime the loop does not arm is accepted, nothing armed"
for entry in "${P9_CASES[@]}"; do
  IFS='|' read -r label _ _ _ _ <<< "$entry"
  boot_lifetime_runner "zt-chan-$label-$$" -e RUNNER_CLAIM_TOKEN="$P9_CLAIM" --add-host "p9.test:$P9_ADDR"
done
for entry in "${P9_CASES[@]}"; do
  IFS='|' read -r label line want_reply want_rule want_reason <<< "$entry"
  name="zt-chan-$label-$$"
  awaiting=no
  for _ in $(seq 1 60); do
    if docker logs "$name" 2>&1 | grep -q "awaiting assignment on the channel"; then awaiting=yes; break; fi
    [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" == "true" ]] || break
    sleep 0.5
  done
  if [[ "$awaiting" != yes ]]; then
    fail "assignment channel, '$line'" "the loop never awaited its assignment: $(docker logs "$name" 2>&1 | tail -10)"
    continue
  fi
  reply=$(channel_line "$name" "$line")
  sleep 1
  rule=none
  docker exec "$name" iptables -S OUTPUT 2>/dev/null | grep -qx -- "-A OUTPUT -d $P9_ADDR/32 -j ACCEPT" && rule=rule
  logs=$(docker logs "$name" 2>&1)
  facts="answer '$reply', $P9_ADDR rule: $rule; $(grep -oE 'lifetime_[a-z]+[^—]*|ASSIGN refusing[^:]*' <<< "$logs" | tr '\n' ' ')"
  ok=yes
  [[ "$reply" == "$want_reply" && "$rule" == "$want_rule" ]] || ok=no
  grep -q "lifetime_armed" <<< "$logs" && ok=no
  if [[ -n "$want_reason" ]]; then
    grep -qF -- "lifetime_invalid from=channel $want_reason" <<< "$logs" || ok=no
  else
    grep -q "lifetime_" <<< "$logs" && ok=no
  fi
  if [[ "$ok" == yes ]]; then
    pass "assignment channel: '$line' — $want_reply, $([[ "$want_rule" == rule ]] && echo "its host's rule installed" || echo "no rule installed"), nothing armed ($facts)"
  else
    fail "assignment channel, '$line'" "$facts — expected: $want_reply, $want_rule, nothing armed${want_reason:+, lifetime_invalid $want_reason}"
  fi
done

# A valid lifetime, then a host list whose second host the loop refuses: the whole
# list is judged before its first rule, so the assignment is refused with no rule
# at all — the first host's included —, and the log says so. The lifetime is armed
# before the hosts are applied: the refused machine still ends at its lifetime.
P9_REFUSED_LIFETIME_S=8
P9_REFUSED_LINE="$P9_REFUSED_LIFETIME_S;p9.test,b@d"
P9_REFUSED="zt-chan-refused-$$"
log "assignment channel: a valid lifetime and a refused host — refused with no rule, and the machine still ends at its lifetime"
boot_lifetime_runner "$P9_REFUSED" -e RUNNER_CLAIM_TOKEN="$P9_CLAIM" --add-host "p9.test:$P9_ADDR"
if ! await_assignment "$P9_REFUSED"; then
  fail "assignment channel, '$P9_REFUSED_LINE'" "the loop never awaited its assignment: $(docker logs "$P9_REFUSED" 2>&1 | tail -10)"
else
  R_START=$(date +%s)
  R_REPLY=$(channel_line "$P9_REFUSED" "$P9_REFUSED_LINE")
  sleep 1
  R_RULE=none
  docker exec "$P9_REFUSED" iptables -S OUTPUT 2>/dev/null | grep -qx -- "-A OUTPUT -d $P9_ADDR/32 -j ACCEPT" && R_RULE=rule
  read -r R_ENDED R_SEEN <<< "$(wait_end "$P9_REFUSED" $((R_START + P9_REFUSED_LIFETIME_S + 25)))"
  R_LOGS=$(docker logs "$P9_REFUSED" 2>&1)
  R_FACTS="answer '$R_REPLY', $P9_ADDR rule: $R_RULE; ended=$R_ENDED $((R_SEEN - R_START)) s after the line; $(grep -oE 'lifetime_(armed|guardian|reached)[^—]*|ASSIGN refusing[^—]*|assignment refused[^;]*' <<< "$R_LOGS" | tr '\n' ' ')"
  if [[ "$R_REPLY" == REFUSED && "$R_RULE" == none && "$R_ENDED" == yes ]] &&
    grep -qF "ASSIGN refusing malformed host: b@d" <<< "$R_LOGS" &&
    grep -qF "assignment refused — no rules installed" <<< "$R_LOGS" &&
    ! grep -q "ASSIGN  p9.test" <<< "$R_LOGS" &&
    grep -q "lifetime_armed from=channel lifetime_s=$P9_REFUSED_LIFETIME_S " <<< "$R_LOGS" &&
    grep -q "lifetime_guardian pid=[0-9]* " <<< "$R_LOGS" &&
    grep -q "lifetime_reached runner_pid=[0-9]* comm=node " <<< "$R_LOGS"; then
    pass "assignment channel: '$P9_REFUSED_LINE' — REFUSED before any rule, the first host's included, said so; the lifetime armed, and the machine ended at it ($R_FACTS)"
  else
    fail "assignment channel, '$P9_REFUSED_LINE'" "$R_FACTS — expected: REFUSED, no $P9_ADDR rule and no ASSIGN line for p9.test, 'b@d' refused, 'no rules installed', the lifetime armed from the channel and its guardian started, the machine ended at it"
  fi
fi

# ---------- An IPv6 literal in allowed_hosts, on both paths ----------
#
# The server passes an IPv6 literal to the sandbox bare. A machine created for a
# run reads it at boot; a pre-created one receives it at its assignment, on the
# channel. Both must install the same rule, whatever the spelling: the address
# getent reads in the literal — here one written as it canonically is, one with
# its zeros written out. A text that holds ':' and is no address is refused at the
# assignment. Both kinds of machine sit on the IPv6 network:
# without an IPv6 address, getent reads no IPv6 literal at all.
V6_LITERALS="2606:4700::1111,2606:4700:0:0:0:0:0:1112"
V6_WANT="2606:4700::1111 2606:4700::1112"

# v6_accepts <container> — each wanted address and the number of its ACCEPT rules.
v6_accepts() {
  local rules a out=""
  rules=$(docker exec "$1" ip6tables -S OUTPUT 2>/dev/null)
  for a in $V6_WANT; do
    out+="$a=$(grep -cxF -- "-A OUTPUT -d $a/128 -j ACCEPT" <<< "$rules") "
  done
  echo "${out% }"
}


log "IPv6 literal: the same rule installed at boot and at the assignment, a text that is no address refused"
V6_COLD="zt-v6-cold-$$"
if boot_egress_runner "$V6_COLD" "$V6_LITERALS"; then
  V6_COLD_RULES=$(v6_accepts "$V6_COLD")
  if [[ "$V6_COLD_RULES" == "2606:4700::1111=1 2606:4700::1112=1" ]]; then
    pass "IPv6 literal, at boot: '$V6_LITERALS' — one ACCEPT per address ($V6_COLD_RULES)"
  else
    fail "IPv6 literal, at boot" "'$V6_LITERALS' — ACCEPT rules: $V6_COLD_RULES; expected one per address"
  fi
else
  fail "IPv6 literal, at boot" "the runner did not boot: $(docker logs "$V6_COLD" 2>&1 | tail -20)"
fi

V6_POOL="zt-v6-pool-$$"
V6_BAD="zt-v6-bad-$$"
if [[ "$EGRESS_READY" -eq 1 ]]; then
  boot_lifetime_runner "$V6_POOL" --network "$EGRESS_NET" -e RUNNER_CLAIM_TOKEN="$P9_CLAIM"
  boot_lifetime_runner "$V6_BAD" --network "$EGRESS_NET" -e RUNNER_CLAIM_TOKEN="$P9_CLAIM"
fi
if [[ "$EGRESS_READY" -eq 1 ]] && await_assignment "$V6_POOL"; then
  V6_REPLY=$(channel_line "$V6_POOL" ";$V6_LITERALS")
  # A few one-second cycles of the loop, which must keep the rules as they are.
  sleep 3
  V6_POOL_RULES=$(v6_accepts "$V6_POOL")
  V6_POOL_FACTS="answer '$V6_REPLY', ACCEPT rules after three cycles: $V6_POOL_RULES; $(docker logs "$V6_POOL" 2>&1 | grep -oE 'ASSIGN[^—]*' | tr '\n' ' ')"
  if [[ "$V6_REPLY" == OK && "$V6_POOL_RULES" == "2606:4700::1111=1 2606:4700::1112=1" ]]; then
    pass "IPv6 literal, at the assignment: '$V6_LITERALS' — the rules of the boot, kept by the loop ($V6_POOL_FACTS)"
  else
    fail "IPv6 literal, at the assignment" "$V6_POOL_FACTS — expected: OK, one ACCEPT per address"
  fi
else
  fail "IPv6 literal, at the assignment" "the loop never awaited its assignment: $(docker logs "$V6_POOL" 2>&1 | tail -10)"
fi
if [[ "$EGRESS_READY" -eq 1 ]] && await_assignment "$V6_BAD"; then
  V6_BAD_REPLY=$(channel_line "$V6_BAD" ";1:2")
  sleep 1
  V6_BAD_FACTS="answer '$V6_BAD_REPLY'; $(docker logs "$V6_BAD" 2>&1 | grep -oE 'ASSIGN refusing[^—]*' | tr '\n' ' ')"
  if [[ "$V6_BAD_REPLY" == REFUSED ]] && docker logs "$V6_BAD" 2>&1 | grep -qF "ASSIGN refusing malformed host: 1:2 (not an IPv6 literal)"; then
    pass "IPv6 literal, at the assignment: '1:2' holds ':' and is no address — refused ($V6_BAD_FACTS)"
  else
    fail "IPv6 literal, at the assignment, '1:2'" "$V6_BAD_FACTS — expected: REFUSED, '1:2' named as no IPv6 literal"
  fi
else
  fail "IPv6 literal, at the assignment, '1:2'" "the loop never awaited its assignment: $(docker logs "$V6_BAD" 2>&1 | tail -10)"
fi

# ---------- The infrastructure check after the assignment ----------
#
# A machine's infrastructure hosts — the object store, the package registries — are
# opened once, at boot, and the boot keeps the addresses it opened in
# /run/skrun-infra-ips. A pre-created machine can sleep long after: once it has
# answered its assignment, its root loop resolves them again and writes one word in
# /run/skrun-infra-check — changed (an address resolved now that the boot opened no
# rule for), unmeasured (no snapshot, or a host that resolves to nothing now) or
# unchanged —, every rule left as it is. Here the infrastructure host is a name of
# /etc/hosts, which root edits between the boot and the assignment, as a moved
# address would; a host that no longer resolves is sent to a nameserver that
# refuses at once, or to one that never answers — a slow measurement, which the
# answer to the assignment must not wait for. The agent's uid reads the word, and
# can neither write, remove nor replace either file, nor create one beside them.
INFRA_A=203.0.113.7
INFRA_B=203.0.113.8
INFRA_NEW=203.0.113.9
INFRA_SLOW=203.0.113.20
INFRA_CHECK_FILE=/run/skrun-infra-check
INFRA_SNAPSHOT_FILE=/run/skrun-infra-ips
# label|the edit between the boot and the assignment|the word expected
INFRA_CASES=(
  "same|none|unchanged"
  "moved|move|changed"
  "added|add|changed"
  "removed|remove|unchanged"
  "failed|forget|unmeasured"
  "slow|slow|unmeasured"
)

# infra_edit <container> <edit> — as root, what a sleeping machine's names undergo.
infra_edit() {
  docker exec "$1" bash -c '
    a=$2 b=$3 new=$4
    keep() { local h; h=$(awk "$1" /etc/hosts); printf "%s\n" "$h" > /etc/hosts; }
    case "$1" in
      none) ;;
      move) keep "{ if (\$1 == \"$a\") \$1 = \"$new\"; print }" ;;
      add) printf "%s\tinfra.test\n" "$new" >> /etc/hosts ;;
      remove) keep "\$1 != \"$b\"" ;;
      forget)
        keep "\$2 != \"infra.test\""
        printf "nameserver 127.0.0.1\n" > /etc/resolv.conf ;;
      slow)
        keep "\$2 != \"slow.test\""
        printf "nameserver 127.0.0.1\noptions timeout:4 attempts:1\n" > /etc/resolv.conf ;;
    esac' _ "$2" "$INFRA_A" "$INFRA_B" "$INFRA_NEW" 2>&1
  if [[ "$2" == slow ]]; then
    # A nameserver that takes every query and never answers.
    docker exec -d "$1" python3 -c 'import socket, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("127.0.0.1", 53))
time.sleep(600)'
    sleep 1
  fi
}

# rules_of <container> — both families' OUTPUT rules.
rules_of() { docker exec "$1" bash -c 'iptables -S OUTPUT; ip6tables -S OUTPUT' 2>&1; }

log "infrastructure check: one word after the assignment's answer, no rule moved, out of the agent's reach"
for entry in "${INFRA_CASES[@]}"; do
  IFS='|' read -r label edit _ <<< "$entry"
  extra=(--add-host "infra.test:$INFRA_A" -e RUNNER_INFRA_HOSTS=infra.test)
  [[ "$edit" == remove ]] && extra+=(--add-host "infra.test:$INFRA_B")
  [[ "$edit" == slow ]] && extra=(--add-host "infra.test:$INFRA_A" --add-host "slow.test:$INFRA_SLOW" -e RUNNER_INFRA_HOSTS=infra.test,slow.test)
  boot_lifetime_runner "zt-infra-$label-$$" -e RUNNER_CLAIM_TOKEN="$P9_CLAIM" "${extra[@]}"
done
for entry in "${INFRA_CASES[@]}"; do
  IFS='|' read -r label edit want <<< "$entry"
  name="zt-infra-$label-$$"
  if ! await_assignment "$name"; then
    fail "infrastructure check, $label" "the loop never awaited its assignment: $(docker logs "$name" 2>&1 | tail -10)"
    continue
  fi
  infra_edit "$name" "$edit"
  before=$(rules_of "$name")
  t0=$(date +%s%N)
  reply=$(channel_line "$name" ";")
  t1=$(date +%s%N)
  answer_ms=$(( (t1 - t0) / 1000000 ))
  at_answer=absent
  docker exec "$name" test -e "$INFRA_CHECK_FILE" 2>/dev/null && at_answer=present
  word=""
  for _ in $(seq 1 60); do
    word=$(docker exec "$name" cat "$INFRA_CHECK_FILE" 2>/dev/null)
    [[ -n "$word" ]] && break
    sleep 0.5
  done
  after=$(rules_of "$name")
  moved=no
  [[ "$before" == "$after" ]] || moved=yes
  facts="answer '$reply' in ${answer_ms} ms, the word $at_answer at the answer, then '${word:-none}'; rules moved: $moved; $(docker logs "$name" 2>&1 | grep -oE 'infra_check[^—]*' | tr '\n' ' ')"
  ok=yes
  [[ "$reply" == OK && "$word" == "$want" && "$moved" == no ]] || ok=no
  [[ "$label" == slow ]] && { [[ "$at_answer" == absent && "$answer_ms" -lt 2500 ]] || ok=no; }
  if [[ "$ok" == yes ]]; then
    pass "infrastructure check, $label: '$want' after the assignment's answer, no rule moved ($facts)"
  else
    fail "infrastructure check, $label" "$facts — expected: OK, '$want', no rule moved$([[ "$label" == slow ]] && echo ", the answer within 2.5 s and before the word")"
  fi
done

# The boot's snapshot, and both files out of the agent's reach, on a machine whose
# check is written.
INFRA_SAME="zt-infra-same-$$"
SNAPSHOT=$(docker exec "$INFRA_SAME" cat "$INFRA_SNAPSHOT_FILE" 2>&1)
if [[ "$SNAPSHOT" == "infra.test|$INFRA_A" ]]; then
  pass "infrastructure check: the boot kept the address it opened ($INFRA_SNAPSHOT_FILE: '$SNAPSHOT')"
else
  fail "infrastructure check, the boot's snapshot" "$INFRA_SNAPSHOT_FILE read '$SNAPSHOT' — expected 'infra.test|$INFRA_A'"
fi
GESTURES=$(docker exec -u 1000 "$INFRA_SAME" bash -c '
  for f in "$1" "$2"; do
    echo "read $f: $(cat "$f" 2>&1 | head -1)"
    out=$( (echo forged > "$f") 2>&1 ); echo "write $f: rc=$? $out"
    out=$(rm -f "$f" 2>&1); echo "remove $f: rc=$? $out"
    echo forged > /tmp/forged
    out=$(mv -f /tmp/forged "$f" 2>&1); echo "replace $f: rc=$? $out"
  done
  out=$(touch /run/skrun-infra-forged 2>&1); echo "create beside: rc=$? $out"
  echo "after: $(cat "$1" 2>&1) | $(cat "$2" 2>&1)"' _ "$INFRA_CHECK_FILE" "$INFRA_SNAPSHOT_FILE" 2>&1)
REFUSED=$(grep -cE 'rc=1 .*(Permission denied|Operation not permitted)' <<< "$GESTURES")
if [[ "$(grep -c 'rc=0' <<< "$GESTURES")" -eq 0 && "$REFUSED" -eq 7 ]] &&
  grep -qx "read $INFRA_CHECK_FILE: unchanged" <<< "$GESTURES" &&
  grep -qxF "after: unchanged | infra.test|$INFRA_A" <<< "$GESTURES"; then
  pass "infrastructure check: the agent's uid reads the word, and is refused writing, removing and replacing both files, and creating one beside them ($(tr '\n' ';' <<< "$GESTURES"))"
else
  fail "infrastructure check, out of reach" "$(tr '\n' ';' <<< "$GESTURES") — expected: the word read, seven refusals (rc=1, permission denied or not permitted), both files as root wrote them"
fi

# ---------- What /init reports of the infrastructure check ----------
#
# A pre-created machine's runner reports that word in its answer to /init
# (infra_hosts). A successful /init reads it once, without waiting: a word not
# written yet is reported unmeasured, and never delays the run. A failed /init
# waits for it, for a bounded time, so that a failure that comes before the word —
# within milliseconds, while the measurement still resolves behind a slow
# nameserver — still carries it. A download from an address the boot opened no
# rule for is not such a failure: under the default-DROP egress its connection is
# not refused, it goes unanswered until the download's own connect timeout, by
# when the word is written. The bundle is served by a container of the egress
# network, under an infrastructure host that is a name of /etc/hosts: in the moved
# case, that name pointed elsewhere at boot and is moved to the server before the
# assignment, so the download meets no rule; in the early case, the download is
# refused at once — a port nothing listens on, at an address the boot opened —
# while a second host has moved and a third is left to a nameserver that answers
# each query after a quarter of a second, a measurement still running when /init fails.
# A machine created for its run measures nothing: its runner reports no word, and
# does not wait for one.
INIT_RUN_TOKEN="run-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
INIT_FIXTURE="zt-init-fixture-$$"
INIT_STALE=203.0.113.30
INIT_DELAY=203.0.113.31
# label|the edit between the boot and the assignment|wait for the word before /init|the bundle's port|status|word|bound on /init, ms
INIT_CASES=(
  "unchanged|none|wait|8000|200|unchanged|"
  "changed|move|wait|8000|200|changed|"
  "slow|slow|now|8000|200|unmeasured|1500"
  "moved|stale|now|8000|500|changed|"
  "early|early|now|8001|500|changed|2500"
)

# runner_listening <container> — until its runner answers /healthz, or 15 s.
runner_listening() {
  docker exec "$1" bash -c 'for _ in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:9000/healthz && exit 0; sleep 0.25; done; exit 1' 2>/dev/null
}

# init_edit <container> <edit> — as root, between the boot and the assignment:
# stale moves the bundle's host from the address the boot opened to the server's;
# early moves infra.test, and leaves delay.test to a nameserver that answers every
# query after a quarter of a second, refusing the name. The others are infra_edit's.
init_edit() {
  case "$2" in
    none) ;;
    stale)
      docker exec "$1" bash -c '
        h=$(awk -v fix="$1" "{ if (\$2 == \"bundle.test\") \$1 = fix; print }" /etc/hosts)
        printf "%s\n" "$h" > /etc/hosts' _ "$INIT_FIX_IP" 2>&1 ;;
    early)
      docker exec "$1" bash -c '
        h=$(awk -v a="$1" -v new="$2" "{ if (\$1 == a) \$1 = new; if (\$2 != \"delay.test\") print }" /etc/hosts)
        printf "%s\n" "$h" > /etc/hosts
        printf "nameserver 127.0.0.1\noptions timeout:2 attempts:1\n" > /etc/resolv.conf' _ "$INFRA_A" "$INFRA_NEW" 2>&1
      docker exec -d "$1" python3 -c 'import socket, threading, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("127.0.0.1", 53))
def answer(query, peer):
    time.sleep(0.25)
    s.sendto(query[:2] + bytes([0x81, 0x83]) + query[4:], peer)
while True:
    query, peer = s.recvfrom(512)
    threading.Thread(target=answer, args=(query, peer), daemon=True).start()'
      sleep 1 ;;
    *) infra_edit "$1" "$2" ;;
  esac
}

# init_exchange <container> <bundle URL> <wait|now> — /claim then /init, from inside
# the machine: their statuses, whether the word was there at each answer and the
# time /init took, on one line; then /init's body.
init_exchange() {
  docker exec -e CLAIM="$P9_CLAIM" -e RUN="$INIT_RUN_TOKEN" -e URL="$2" -e WAIT="$3" "$1" bash -c '
    post() { curl -s -m 30 -w "\n%{http_code}" -X POST "http://127.0.0.1:9000$1" \
      -H "Authorization: Bearer $2" -H "Content-Type: application/json" -d "$3"; }
    word() { if [[ -e /run/skrun-infra-check ]]; then echo present; else echo absent; fi; }
    claim=$(post /claim "$CLAIM" "{\"rpcToken\":\"$RUN\",\"allowedHosts\":[]}")
    at_claim=$(word)
    if [[ "$WAIT" == wait ]]; then
      for _ in $(seq 1 100); do [[ -e /run/skrun-infra-check ]] && break; sleep 0.1; done
    fi
    t0=$(date +%s%N)
    init=$(post /init "$RUN" "{\"bundleUrl\":\"$URL\",\"tools\":[],\"mcpServers\":[],\"allowedHosts\":[]}")
    t1=$(date +%s%N)
    echo "claim $(tail -1 <<< "$claim") (the word $at_claim); init $(tail -1 <<< "$init") in $(( (t1 - t0) / 1000000 )) ms (the word $(word))"
    head -n -1 <<< "$init"' 2>&1
}

log "/init and the infrastructure check: read without waiting on success, waited for within a bound on failure, absent on a machine created for its run"
INIT_FIX_IP=""
if [[ "$EGRESS_READY" -eq 1 ]]; then
  EGRESS_CONTAINERS+=("$INIT_FIXTURE")
  docker run -d --name "$INIT_FIXTURE" --network "$EGRESS_NET" --entrypoint /bin/bash "$IMAGE" -c '
    mkdir -p /tmp/bundle /tmp/serve && printf "name: init-check\nversion: 1.0.0\n" > /tmp/bundle/agent.yaml &&
    tar -czf /tmp/serve/fixture.agent -C /tmp/bundle . && cd /tmp/serve &&
    exec python3 -m http.server 8000 --bind 0.0.0.0' >/dev/null 2>&1
  for _ in $(seq 1 40); do
    docker exec "$INIT_FIXTURE" curl -sf -o /dev/null http://127.0.0.1:8000/fixture.agent 2>/dev/null && break
    sleep 0.25
  done
  INIT_FIX_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$INIT_FIXTURE" 2>/dev/null)
fi
for entry in "${INIT_CASES[@]}"; do
  IFS='|' read -r label edit _ <<< "$entry"
  [[ -n "$INIT_FIX_IP" ]] || break
  case "$edit" in
    none) extra=(--add-host "bundle.test:$INIT_FIX_IP" -e RUNNER_INFRA_HOSTS=bundle.test) ;;
    move) extra=(--add-host "bundle.test:$INIT_FIX_IP" --add-host "infra.test:$INFRA_A" -e RUNNER_INFRA_HOSTS=bundle.test,infra.test) ;;
    slow) extra=(--add-host "bundle.test:$INIT_FIX_IP" --add-host "slow.test:$INFRA_SLOW" -e RUNNER_INFRA_HOSTS=bundle.test,slow.test) ;;
    stale) extra=(--add-host "bundle.test:$INIT_STALE" -e RUNNER_INFRA_HOSTS=bundle.test) ;;
    early) extra=(--add-host "bundle.test:$INIT_FIX_IP" --add-host "infra.test:$INFRA_A" --add-host "delay.test:$INIT_DELAY"
      -e RUNNER_INFRA_HOSTS=bundle.test,infra.test,delay.test) ;;
  esac
  boot_lifetime_runner "zt-init-$label-$$" --network "$EGRESS_NET" -e RUNNER_CLAIM_TOKEN="$P9_CLAIM" "${extra[@]}"
done
for entry in "${INIT_CASES[@]}"; do
  IFS='|' read -r label edit when port want_status want_word bound <<< "$entry"
  name="zt-init-$label-$$"
  if [[ -z "$INIT_FIX_IP" ]]; then
    fail "/init and the infrastructure check, $label" "the bundle server did not start on the egress network"
    continue
  fi
  if ! await_assignment "$name" || ! runner_listening "$name"; then
    fail "/init and the infrastructure check, $label" "the machine never awaited its assignment: $(docker logs "$name" 2>&1 | tail -10)"
    continue
  fi
  init_edit "$name" "$edit"
  out=$(init_exchange "$name" "http://bundle.test:$port/fixture.agent" "$when")
  summary=$(head -1 <<< "$out")
  body=$(tail -n +2 <<< "$out")
  word=$(grep -oE '"infra_hosts":"[a-z]+"' <<< "$body" | cut -d'"' -f4)
  init_ms=$(grep -oE 'in [0-9]+ ms' <<< "$summary" | grep -oE '[0-9]+')
  facts="$summary; infra_hosts '${word:-absent}'; body $(head -c 300 <<< "$body"); $(docker logs "$name" 2>&1 | grep -oE 'infra_check[^—]*' | tr '\n' ' ')"
  ok=yes
  grep -q "^claim 200 " <<< "$summary" && grep -q "; init $want_status in " <<< "$summary" && [[ "$word" == "$want_word" ]] || ok=no
  [[ -n "$bound" ]] && { [[ -n "$init_ms" && "$init_ms" -lt "$bound" ]] || ok=no; }
  [[ "$label" == slow ]] && { grep -q "ms (the word absent)$" <<< "$summary" || ok=no; }
  [[ "$want_status" == 500 ]] && { grep -q '"stage":"bundle-network"' <<< "$body" || ok=no; }
  [[ "$label" == early ]] && { grep -q "(the word absent); init" <<< "$summary" || ok=no; }
  case "$label" in
    unchanged | changed) what="a successful /init reports the word written, '$want_word'" ;;
    slow) what="a successful /init does not wait for a measurement still running: '$want_word', answered within $bound ms, the word not written yet" ;;
    moved) what="a download from the moved address meets no rule and fails at its connect timeout, unrefused; the failed /init reports '$want_word'" ;;
    early) what="a download refused at once fails /init, which waits for the measurement still running and reports '$want_word', within $bound ms" ;;
  esac
  if [[ "$ok" == yes ]]; then
    pass "/init and the infrastructure check, $label: $what ($facts)"
  else
    fail "/init and the infrastructure check, $label" "$facts — expected: claim 200, init $want_status, infra_hosts '$want_word'${bound:+, within $bound ms}"
  fi
done

INIT_COLD="zt-init-cold-$$"
boot_lifetime_runner "$INIT_COLD" --network "$EGRESS_NET"
if wait_for_runner "$INIT_COLD" && runner_listening "$INIT_COLD"; then
  COLD_OUT=$(docker exec "$INIT_COLD" bash -c '
    t0=$(date +%s%N)
    init=$(curl -s -m 30 -w "\n%{http_code}" -X POST http://127.0.0.1:9000/init -H "Content-Type: application/json" \
      -d "{\"bundleUrl\":\"http://127.0.0.1:1/fixture.agent\",\"tools\":[],\"mcpServers\":[],\"allowedHosts\":[]}")
    t1=$(date +%s%N)
    echo "init $(tail -1 <<< "$init") in $(( (t1 - t0) / 1000000 )) ms"
    head -n -1 <<< "$init"' 2>&1)
  COLD_MS=$(head -1 <<< "$COLD_OUT" | grep -oE 'in [0-9]+ ms' | grep -oE '[0-9]+')
  COLD_FACTS="$(head -1 <<< "$COLD_OUT"); body $(tail -n +2 <<< "$COLD_OUT" | head -c 300)"
  if head -1 <<< "$COLD_OUT" | grep -q "^init 500 " && ! grep -q '"infra_hosts"' <<< "$COLD_OUT" &&
    [[ -n "$COLD_MS" && "$COLD_MS" -lt 1000 ]]; then
    pass "/init and the infrastructure check, machine created for its run: a failed /init reports no word and does not wait for one ($COLD_FACTS)"
  else
    fail "/init and the infrastructure check, machine created for its run" "$COLD_FACTS — expected: init 500, no infra_hosts, within 1000 ms"
  fi
else
  fail "/init and the infrastructure check, machine created for its run" "the runner did not boot: $(docker logs "$INIT_COLD" 2>&1 | tail -10)"
fi

# ---------- The three forms of the blocked-address rule agree, in the image ----------
#
# One list, BLOCKED_RANGES, reaches the image in two ways: compiled into the
# runtime package the runner loads, and as the file the build writes from it. Three
# forms read them: the runtime's isPrivateHost, the shell's is_private_ip, and the
# DROP rules setup_iptables installs. Each witness below must get the same verdict
# from all three, and the verdict it is listed under.
PARITY_BLOCKED=(
  0.0.0.0 10.0.0.1 100.64.0.1 127.0.0.1 169.254.169.254 172.16.0.1 192.0.0.8 192.0.2.1
  192.88.99.1 192.168.1.1 198.18.0.1 198.51.100.1 203.0.113.1 224.0.0.1 240.0.0.1
  255.255.255.255 :: 0:0:0:0:0:0:0:0 ::1 ::7f00:1 ::ffff:10.0.0.1 ::ffff:8.8.8.8 ::ffff:0:7f00:1
  64:ff9b::a00:1 64:ff9b:1::1 100::1 100:0:0:1::5 2001::1 2001:db8::1 2002::1 3fff::1 5f00::1
  fc00::1 fd00::1 fe80::1 fec0::1 ff02::1
)
PARITY_PUBLIC=(
  8.8.8.8 1.1.1.1 93.184.216.34 172.32.0.1 100.128.0.1 198.20.0.1
  2001:4860:4860::8888 2606:4700:4700::1111 2001:200::1
)
log "blocked-address rule: the runtime predicate, the shell check and the DROP rules agree"
PARITY_OUT=$(docker run --rm -i --cap-add NET_ADMIN --security-opt no-new-privileges:true \
  --entrypoint /bin/bash "$IMAGE" -s -- "${PARITY_BLOCKED[@]}" "${PARITY_PUBLIC[@]}" 2>&1 <<'PARITY'
set -u
source /usr/local/bin/net-lib.sh
if ! setup_iptables >/dev/null 2>&1; then echo "SETUP_FAILED"; exit 0; fi
for a in "$@"; do
  if is_private_ip "$a"; then echo "blocked"; else echo "public"; fi
done > /tmp/shell.txt
node --input-type=module -e '
  const { isPrivateHost } = await import("/opt/skrun-runner/node_modules/@skrun-dev/runtime/dist/security/network.js");
  for (const a of process.argv.slice(1)) console.log(isPrivateHost(a) ? "blocked" : "public");
' "$@" > /tmp/runtime.txt 2>&1
{ iptables -S OUTPUT; ip6tables -S OUTPUT; } |
  awk '$1 == "-A" && $3 == "-d" && $5 == "-j" && $6 == "DROP" && NF == 6 { print $4 }' > /tmp/drops.txt
python3 -c '
import ipaddress, sys
drops = [ipaddress.ip_network(line.strip()) for line in open("/tmp/drops.txt") if line.strip()]
for a in sys.argv[1:]:
    ip = ipaddress.ip_address(a)
    print("blocked" if any(ip.version == n.version and ip in n for n in drops) else "public")
' "$@" > /tmp/rules.txt 2>&1
echo "DROP_RULES $(wc -l < /tmp/drops.txt)"
i=0
for a in "$@"; do
  i=$((i + 1))
  echo "VERDICT $a $(sed -n "${i}p" /tmp/shell.txt) $(sed -n "${i}p" /tmp/runtime.txt) $(sed -n "${i}p" /tmp/rules.txt)"
done
PARITY
)
PARITY_BAD=""
PARITY_SEEN=0
for addr in "${PARITY_BLOCKED[@]}" "${PARITY_PUBLIC[@]}"; do
  want=public
  for b in "${PARITY_BLOCKED[@]}"; do [[ "$b" == "$addr" ]] && want=blocked; done
  line=$(grep -F -x -- "VERDICT $addr $want $want $want" <<< "$PARITY_OUT")
  if [[ -n "$line" ]]; then
    PARITY_SEEN=$((PARITY_SEEN + 1))
  else
    got=$(grep -F -- "VERDICT $addr " <<< "$PARITY_OUT" | head -1 | cut -d' ' -f3-)
    PARITY_BAD+="$addr (listed $want; shell, runtime, rules: ${got:-no verdict}); "
  fi
done
if [[ -z "$PARITY_BAD" ]]; then
  pass "blocked-address rule: $PARITY_SEEN witnesses, one verdict from the shell check, the runtime predicate and the DROP rules ($(grep -o 'DROP_RULES [0-9]*' <<< "$PARITY_OUT"))"
else
  fail "blocked-address rule" "the three forms disagree: $PARITY_BAD$(grep -E 'SETUP_FAILED|DROP_RULES|Error' <<< "$PARITY_OUT" | head -3)"
fi

# ---------- npm major below the ceiling, on the image ----------
#
# Read the way the workflow's runtime probe reads versions (a plain docker run,
# first line of the output), without the hardening flags of probe(). Only the
# standard output is read: what goes to standard error — docker's warning about
# a platform that is not the host's, say — reaches the log, never the version.
# A run that prints nothing leaves the version empty, and an empty version is
# below nothing: the check fails.
log "npm major: npm --version in the image must be below $NPM_MAJOR_CEILING"
NPM_VERSION=$(docker run --rm --entrypoint /bin/bash "$IMAGE" -c 'npm --version' | head -1)
if npm_major_below "$NPM_VERSION" "$NPM_MAJOR_CEILING"; then
  pass "npm major: npm $NPM_VERSION is below $NPM_MAJOR_CEILING"
else
  fail "npm major" "npm --version read '$NPM_VERSION', expected a major below $NPM_MAJOR_CEILING. npm 12 and newer turn the install scripts of dependencies off by default, so a dependency of an agent script that needs one would install without an error, then break at run time. Before raising this ceiling, list the dependencies of agent scripts that need their install scripts, then choose between a targeted --allow-scripts and pre-building them."
fi

# ---------- Summary ----------
echo
TOTAL=$((PASS_COUNT + FAIL_COUNT))
log "PASS zero-trust: scanned=$TOTAL passed=$PASS_COUNT failed=$FAIL_COUNT"
if [[ "$RESULT" -ne 0 ]]; then
  log "FAIL — $FAIL_COUNT control(s) regressed. Inspect logs above."
fi
exit "$RESULT"
