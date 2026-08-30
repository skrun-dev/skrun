#!/usr/bin/env bash
#
# pool-smoke.sh — behavioural checks for a runner that is created BEFORE it is
# assigned to a run.
#
# WHY HERE AND NOT IN zero-trust.test.sh
# Every case in that suite overrides the entrypoint and re-implements its logic in
# bash. That is a sound way to assert a firewall rule in isolation, and completely
# wrong here: what needs proving is the SHIPPED boot path — the command channel it
# creates, the privileged helper waiting on it, and the server's own view of which
# routes it will answer. Re-implementing any of that would test the copy.
#
# So this boots the real image, unmodified, and talks to it over HTTP — the same
# shape as runner/smoke.sh and runner/init-smoke.sh.
#
# Usage:
#   infra/runtime-image/runner/pool-smoke.sh
#   SMOKE_IMAGE=<tag> infra/runtime-image/runner/pool-smoke.sh
#
set -euo pipefail

TAG="${SMOKE_IMAGE:-skrun-runtime:smoke}"
CLAIM_TOKEN="claim-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
RUN_TOKEN="run-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
CONTAINERS=()
NETWORKS=()
PORT_BASE=9100
WORK="$(mktemp -d)"

command -v docker >/dev/null || {
  echo "POOL-SMOKE: docker not found — run this where Docker is available (CI)."
  exit 3
}

cleanup() {
  for c in "${CONTAINERS[@]:-}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  for n in "${NETWORKS[@]:-}"; do docker network rm "$n" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "POOL-SMOKE FAIL: $1"
  [ -n "${2:-}" ] && docker logs "$2" 2>&1 | tail -40
  exit 1
}

# A bundle the runner can actually fetch, served from a container on its own
# network and allowed through the default-DROP egress the same way the object
# store is in production. Sets FIXTURE_HOST + FIXTURE_URL.
start_fixture_server() {
  local net="$1" host="fixture-$$"
  mkdir -p "$WORK/bundle/scripts" "$WORK/serve"
  printf 'name: pool-smoke\nversion: 1.0.0\n' > "$WORK/bundle/agent.yaml"
  tar -czf "$WORK/serve/fixture.agent" -C "$WORK/bundle" .
  CONTAINERS+=("$host")
  docker run -d --name "$host" --network "$net" --entrypoint /bin/bash \
    -v "$WORK/serve:/srv:ro" \
    "$TAG" -c 'cd /srv && exec python3 -m http.server 8000 --bind 0.0.0.0' >/dev/null
  FIXTURE_HOST="$host"
  FIXTURE_URL="http://$host:8000/fixture.agent"
}

# Boot the image in the pre-created posture: it holds an assignment credential and
# no run credential, which is the state a machine sits in while it waits.
# $3 (optional) docker network · $4 (optional) host to allow through the egress.
boot_pool_runner() {
  local name="$1" port="$2" net="${3:-}" infra="${4:-}"
  CONTAINERS+=("$name")
  docker run -d --name "$name" --cap-add=NET_ADMIN \
    ${net:+--network "$net"} \
    -p "$port:9000" \
    -e SKRUN_CONTAINER_MODE=runner \
    -e RUNNER_PORT=9000 \
    -e RUNNER_CLAIM_TOKEN="$CLAIM_TOKEN" \
    ${infra:+-e RUNNER_INFRA_HOSTS="$infra"} \
    "$TAG" >/dev/null
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:$port/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "runner never became healthy in the pre-created posture" "$name"
}

# HTTP status only — the body is not the assertion here.
#
# Never aborts the script on a transport failure: it reports 000 instead, so a
# timeout shows up as a readable assertion failure rather than `set -e` killing
# the run with a bare curl exit code. (That is exactly what happened first time
# round, on the fail-closed case below.)
#
# `--timeout N` overrides the default, which matters for calls that are SUPPOSED
# to be slow: an assignment waits for the privileged helper to confirm the rules,
# and gives up after 15s by design, so a 5s client timeout would fire first and
# hide the behaviour being tested.
status() {
  local timeout=5
  if [ "${1:-}" = "--timeout" ]; then timeout="$2"; shift 2; fi
  curl -s -o /dev/null -w '%{http_code}' --max-time "$timeout" "$@" || echo "000"
}

# ---------------------------------------------------------------------------
# An unassigned runner answers almost nothing
#
# This is the failure mode the whole design exists to prevent. The server's
# back-compat rule is "no credential configured means open", which is correct for
# a single-tenant deployment and catastrophic for a machine that sits waiting: it
# would serve /init — whose body carries an arbitrary bundle URL — to anything
# that can reach it on the private network.
# ---------------------------------------------------------------------------
PORT=$((PORT_BASE))
NAME="skrun-pool-smoke-unassigned-$$"
boot_pool_runner "$NAME" "$PORT"
BASE="http://localhost:$PORT"
echo "POOL-SMOKE: booted in the pre-created posture"

# Health stays open — the caller polls it before it can authenticate at all.
[ "$(status "$BASE/healthz")" = "200" ] || fail "/healthz should stay open" "$NAME"
echo "POOL-SMOKE: /healthz 200 (open, as it must be)"

# Every route that does real work is refused, credential or not.
for route in /init /tool /outputs/collect; do
  code=$(status -X POST -H 'Content-Type: application/json' -d '{}' "$BASE$route")
  [ "$code" = "401" ] || fail "POST $route should be refused before assignment (got $code)" "$NAME"
  code=$(status -X POST -H "Authorization: Bearer $CLAIM_TOKEN" \
    -H 'Content-Type: application/json' -d '{}' "$BASE$route")
  [ "$code" = "401" ] ||
    fail "POST $route should be refused even WITH the assignment credential (got $code)" "$NAME"
done
code=$(status "$BASE/outputs/file?path=x")
[ "$code" = "401" ] || fail "GET /outputs/file should be refused before assignment (got $code)" "$NAME"
echo "POOL-SMOKE: /init, /tool, /outputs/* all refused — with and without the assignment credential"

# The assignment route itself is credential-gated.
code=$(status -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/claim")
[ "$code" = "401" ] || fail "/claim without a credential should be refused (got $code)" "$NAME"
code=$(status -X POST -H "Authorization: Bearer wrong-$CLAIM_TOKEN" \
  -H 'Content-Type: application/json' -d '{}' "$BASE/claim")
[ "$code" = "401" ] || fail "/claim with a wrong credential should be refused (got $code)" "$NAME"
echo "POOL-SMOKE: /claim refused without a credential and with a wrong one"

# The command channel exists and is out of reach of the unprivileged user the
# server runs as — the second, independent layer under the ordering guarantee.
docker exec "$NAME" test -d /run/skrun-egress || fail "the command channel was not created" "$NAME"
MODE=$(docker exec "$NAME" stat -c '%a %U' /run/skrun-egress)
[ "$MODE" = "700 root" ] || fail "channel directory should be 700 root, got '$MODE'" "$NAME"
if docker exec -u 1000 "$NAME" ls /run/skrun-egress >/dev/null 2>&1; then
  fail "uid 1000 can traverse the channel directory" "$NAME"
fi
echo "POOL-SMOKE: channel directory is 700 root:root and uid 1000 cannot traverse it"

# The privileged helper is alive and waiting rather than having exited.
docker exec "$NAME" sh -c 'ps -eo args | grep -q "[d]ns-reresolve"' ||
  fail "the privileged egress helper is not running" "$NAME"
echo "POOL-SMOKE: the privileged egress helper is waiting for its assignment"

echo "POOL-SMOKE PASS: an unassigned runner serves health only, and its command channel is unreachable."

# ---------------------------------------------------------------------------
# Assignment installs the run credential — exactly once
#
# The first end-to-end use of the command channel: /claim writes the host list on
# an inherited descriptor, the privileged helper reads it, applies the rules and
# answers, and only then is the run credential installed. Everything before this
# point had the helper waiting with nobody talking to it.
# ---------------------------------------------------------------------------
NET="skrun-pool-smoke-net-$$"
NETWORKS+=("$NET")
docker network create "$NET" >/dev/null
start_fixture_server "$NET"

PORT=$((PORT_BASE + 1))
NAME="skrun-pool-smoke-assign-$$"
boot_pool_runner "$NAME" "$PORT" "$NET" "$FIXTURE_HOST"
BASE="http://localhost:$PORT"
echo "POOL-SMOKE: booted a second runner for the assignment case"

CLAIM_BODY="{\"rpcToken\":\"$RUN_TOKEN\",\"allowedHosts\":[]}"
RESPONSE=$(curl -fsS -X POST "$BASE/claim"   -H "Authorization: Bearer $CLAIM_TOKEN"   -H 'Content-Type: application/json'   -d "$CLAIM_BODY" 2>&1) || fail "/claim with the right credential was refused: $RESPONSE" "$NAME"
case "$RESPONSE" in
  *'"ok":true'*) ;;
  *) fail "/claim did not report success: $RESPONSE" "$NAME" ;;
esac
echo "POOL-SMOKE: assignment accepted — the privileged helper confirmed the rules"

# The channel carried one message and is gone. This is what the whole ordering
# argument rests on: by the time any agent code could run, there is nothing left
# to reach.
if docker exec "$NAME" test -e /run/skrun-egress/request 2>/dev/null; then
  fail "the command channel still exists after assignment" "$NAME"
fi
echo "POOL-SMOKE: the command channel was destroyed after its single message"

# The run credential now works, and nothing else does.
code=$(status -X POST -H "Authorization: Bearer $RUN_TOKEN" -H 'Content-Type: application/json'   -d "{\"bundleUrl\":\"$FIXTURE_URL\",\"tools\":[],\"mcpServers\":[],\"allowedHosts\":[]}"   "$BASE/init")
[ "$code" = "200" ] || fail "/init with the run credential should succeed (got $code)" "$NAME"
echo "POOL-SMOKE: /init succeeds with the run credential"

code=$(status -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/tool")
[ "$code" = "401" ] || fail "/tool without a credential should still be refused (got $code)" "$NAME"
code=$(status -X POST -H "Authorization: Bearer $CLAIM_TOKEN" -H 'Content-Type: application/json'   -d '{}' "$BASE/tool")
[ "$code" = "401" ] ||
  fail "the assignment credential must not authorise anything once assigned (got $code)" "$NAME"
echo "POOL-SMOKE: the assignment credential stops working the moment the run credential exists"

# Single use. A second assignment is refused with a distinct status, because the
# caller has to tell "wrong credential" from "already spoken for" — the second
# means discard this machine, not retry with another token.
code=$(status -X POST -H "Authorization: Bearer $CLAIM_TOKEN" -H 'Content-Type: application/json'   -d "{\"rpcToken\":\"other-$RUN_TOKEN\",\"allowedHosts\":[]}" "$BASE/claim")
[ "$code" = "409" ] || fail "a second assignment should be refused with 409 (got $code)" "$NAME"
code=$(status -X POST -H "Authorization: Bearer $RUN_TOKEN" -H 'Content-Type: application/json'   -d '{}' "$BASE/outputs/collect")
[ "$code" != "401" ] || fail "the FIRST run credential must remain the valid one" "$NAME"
echo "POOL-SMOKE: a second assignment is refused (409) and the first credential still holds"

echo "POOL-SMOKE PASS: assignment installs the run credential exactly once, and destroys the channel."

# ---------------------------------------------------------------------------
# The agent's egress rules are installed at assignment — and refused correctly
#
# Every case above passed an empty host list, so the helper had nothing to do.
# This is the first time it actually resolves names and writes firewall rules,
# through the channel, long after the boot-time setup has finished and the server
# has lost the privileges to do it itself.
# ---------------------------------------------------------------------------
PORT=$((PORT_BASE + 2))
NAME="skrun-pool-smoke-egress-$$"
CONTAINERS+=("$NAME")
# A name that resolves to a private address, to prove the rebinding defence still
# applies to a list that arrives over the channel rather than at boot.
docker run -d --name "$NAME" --cap-add=NET_ADMIN \
  --add-host "private-target:10.11.12.13" \
  -p "$PORT:9000" \
  -e SKRUN_CONTAINER_MODE=runner \
  -e RUNNER_PORT=9000 \
  -e RUNNER_CLAIM_TOKEN="$CLAIM_TOKEN" \
  "$TAG" >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
BASE="http://localhost:$PORT"
curl -fsS "$BASE/healthz" >/dev/null || fail "egress-case runner never became healthy" "$NAME"

# Before assignment nothing agent-declared is reachable: the boot-time setup
# installed the policy and the infrastructure allowances, nothing else.
if docker exec "$NAME" curl -s -m 8 -o /dev/null https://example.com; then
  fail "example.com was reachable BEFORE assignment — the default policy is not holding" "$NAME"
fi
echo "POOL-SMOKE: nothing agent-declared is reachable before assignment"

RESPONSE=$(curl -fsS -X POST "$BASE/claim" \
  -H "Authorization: Bearer $CLAIM_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"rpcToken\":\"$RUN_TOKEN\",\"allowedHosts\":[\"example.com\",\"private-target\"]}" 2>&1) \
  || fail "/claim with a real host list was refused: $RESPONSE" "$NAME"
echo "POOL-SMOKE: assignment with a real host list accepted"

docker exec "$NAME" curl -fsS -m 15 -o /dev/null https://example.com \
  || fail "a declared host is still unreachable after assignment" "$NAME"
echo "POOL-SMOKE: the declared host became reachable — the helper wrote the rules"

# A public address that was never declared stays blocked.
if docker exec "$NAME" curl -s -m 8 -o /dev/null http://1.1.1.1; then
  fail "an undeclared address is reachable — the allowlist is not an allowlist" "$NAME"
fi
echo "POOL-SMOKE: an undeclared address stays blocked"

# The rebinding defence survives the channel: a declared name that resolves to a
# private address is refused, exactly as it is at boot. Without this, a hostile
# host list could open a route into the internal network.
if docker exec "$NAME" sh -c 'iptables -S OUTPUT | grep -q 10.11.12.13'; then
  fail "a declared host resolving to a private address was ACCEPTed" "$NAME"
fi
docker exec "$NAME" sh -c 'grep -q "example.com|" /run/skrun-allowed-ips' \
  || fail "the declared public host was not recorded in the re-resolve state" "$NAME"
docker exec "$NAME" sh -c '! grep -q "private-target|" /run/skrun-allowed-ips' \
  || fail "the private-resolving host leaked into the re-resolve state" "$NAME"
echo "POOL-SMOKE: a declared host resolving to a private address was refused (rebinding defence intact)"

# ---------------------------------------------------------------------------
# Fail closed: no confirmation, no run
#
# If the privileged helper cannot confirm the rules, the run credential must NOT
# be installed. A run that began with its firewall unconfirmed would be a sandbox
# without a sandbox — the same property the boot path has, where a failed setup
# aborts the boot outright.
# ---------------------------------------------------------------------------
PORT=$((PORT_BASE + 3))
NAME="skrun-pool-smoke-failclosed-$$"
boot_pool_runner "$NAME" "$PORT"
BASE="http://localhost:$PORT"

docker exec "$NAME" pkill -f dns-reresolve || fail "could not stop the privileged helper" "$NAME"
echo "POOL-SMOKE: privileged helper stopped — no one can confirm the rules now"

# Waits out the runner's own confirmation deadline — the point is that it gives up
# and refuses, not that it answers quickly.
CODE=$(status --timeout 30 -X POST "$BASE/claim" \
  -H "Authorization: Bearer $CLAIM_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"rpcToken\":\"$RUN_TOKEN\",\"allowedHosts\":[\"example.com\"]}")
[ "$CODE" = "500" ] || fail "an unconfirmed assignment should fail (got $CODE)" "$NAME"
echo "POOL-SMOKE: the assignment failed rather than proceeding unconfirmed"

# No run credential was installed, so the machine cannot run anything...
CODE=$(status -X POST -H "Authorization: Bearer $RUN_TOKEN" -H 'Content-Type: application/json' \
  -d '{}' "$BASE/init")
[ "$CODE" = "401" ] || fail "a failed assignment must not install the run credential (got $CODE)" "$NAME"
# ...and it cannot be assigned again either. Latched and spent, which is the
# intended terminal state: the caller destroys it rather than retrying.
CODE=$(status -X POST -H "Authorization: Bearer $CLAIM_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"rpcToken\":\"$RUN_TOKEN\",\"allowedHosts\":[]}" "$BASE/claim")
[ "$CODE" = "409" ] || fail "a machine whose assignment failed must stay spent (got $CODE)" "$NAME"
echo "POOL-SMOKE: the machine is left unusable — no credential, and no second attempt"

echo "POOL-SMOKE PASS: egress is installed at assignment, filtered as at boot, and fails closed."

# ---------------------------------------------------------------------------
# Agent code cannot reach the command channel
#
# The heaviest case, and the one the whole ordering argument is for. Agent scripts
# run as the SAME user as the server, so nothing here can rest on a secret or on
# file permissions alone. What it rests on is that by the time any agent code can
# run, the channel no longer exists: assignment strictly precedes initialisation,
# which precedes the first tool call.
#
# Proving that needs a real dispatched child process — which is why the bundle
# work in init-smoke.sh had to come first.
# ---------------------------------------------------------------------------
NET2="skrun-pool-smoke-net2-$$"
NETWORKS+=("$NET2")
docker network create "$NET2" >/dev/null

HOSTILE_SRV="hostile-fixture-$$"
mkdir -p "$WORK/hostile/scripts" "$WORK/hostile-serve"
printf 'name: hostile\nversion: 1.0.0\n' > "$WORK/hostile/agent.yaml"
cat > "$WORK/hostile/scripts/probe.py" <<'PY'
# Runs as the tool of an assigned machine — i.e. as agent code, under the same
# user as the server. Goes looking for every way back to the privileged helper.
import json, os, socket

out = {}

out["chan_dir_exists"] = os.path.exists("/run/skrun-egress")
try:
    os.listdir("/run/skrun-egress")
    out["chan_dir_listable"] = True
except Exception:
    out["chan_dir_listable"] = False

# Every descriptor this process was handed, and where it points.
fds = {}
for fd in os.listdir("/proc/self/fd"):
    try:
        fds[fd] = os.readlink("/proc/self/fd/" + fd)
    except Exception:
        fds[fd] = "?"
out["fds"] = fds
out["channel_fds"] = [f for f, t in fds.items() if "skrun-egress" in t]

# The re-resolve state file the helper diffs against.
try:
    with open("/run/skrun-allowed-ips", "a") as f:
        f.write("evil.example|203.0.113.7\n")
    out["state_writable"] = True
except Exception:
    out["state_writable"] = False

# And plain reachability of something never declared.
try:
    socket.create_connection(("1.1.1.1", 80), timeout=4).close()
    out["undeclared_reachable"] = True
except Exception:
    out["undeclared_reachable"] = False

print(json.dumps(out))
PY
tar -czf "$WORK/hostile-serve/hostile.agent" -C "$WORK/hostile" .
CONTAINERS+=("$HOSTILE_SRV")
docker run -d --name "$HOSTILE_SRV" --network "$NET2" --entrypoint /bin/bash \
  -v "$WORK/hostile-serve:/srv:ro" \
  "$TAG" -c 'cd /srv && exec python3 -m http.server 8000 --bind 0.0.0.0' >/dev/null

PORT=$((PORT_BASE + 4))
NAME="skrun-pool-smoke-agentcode-$$"
boot_pool_runner "$NAME" "$PORT" "$NET2" "$HOSTILE_SRV"
BASE="http://localhost:$PORT"

curl -fsS -X POST "$BASE/claim" -H "Authorization: Bearer $CLAIM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"rpcToken\":\"$RUN_TOKEN\",\"allowedHosts\":[]}" >/dev/null \
  || fail "assignment failed on the agent-code case" "$NAME"

TOOLS='[{"name":"probe","description":"probe","input_schema":{"type":"object","properties":{},"additionalProperties":false}}]'
curl -fsS -X POST "$BASE/init" -H "Authorization: Bearer $RUN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"bundleUrl\":\"http://$HOSTILE_SRV:8000/hostile.agent\",\"tools\":$TOOLS,\"mcpServers\":[],\"allowedHosts\":[]}" \
  >/dev/null || fail "/init failed on the agent-code case" "$NAME"
echo "POOL-SMOKE: assigned + initialised with a probing tool"

PROBE=$(curl -fsS -X POST "$BASE/tool" -H "Authorization: Bearer $RUN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"kind":"script","name":"probe","args":{}}' 2>&1) \
  || fail "the probe tool did not run: $PROBE" "$NAME"
echo "POOL-SMOKE: probe output: $PROBE"

# The channel is gone, so there is nothing to reach by path...
case "$PROBE" in
  *'chan_dir_listable\": true'*|*'chan_dir_listable": true'*)
    fail "agent code could list the channel directory" "$NAME" ;;
esac
# ...and nothing was handed to the child either. This is the load-bearing one:
# descriptors are not passed to spawned children, and the server closes its own
# before any tool can be dispatched.
case "$PROBE" in
  *skrun-egress*) fail "agent code holds a descriptor onto the channel: $PROBE" "$NAME" ;;
esac
# The helper's state file is not agent-writable.
case "$PROBE" in
  *'state_writable\": true'*|*'state_writable": true'*)
    fail "agent code could write the privileged helper's state file" "$NAME" ;;
esac
# And the egress it was given is the egress it has.
case "$PROBE" in
  *'undeclared_reachable\": true'*|*'undeclared_reachable": true'*)
    fail "agent code reached an address that was never declared" "$NAME" ;;
esac

echo "POOL-SMOKE PASS: agent code finds no channel, no descriptor, no writable state, no extra egress."

# ---------------------------------------------------------------------------
# The baked language runtimes still resolve in the pre-created posture
#
# The boot path forks earlier than it used to, so the runtimes are re-probed on
# THAT branch rather than assumed to carry over from the cold one.
# ---------------------------------------------------------------------------
PORT=$((PORT_BASE + 5))
NAME="skrun-pool-smoke-runtimes-$$"
boot_pool_runner "$NAME" "$PORT"
for probe in "python3 --version" "node --version" "go version" "rustc --version" \
             "ruby --version" "java -version" "php --version"; do
  docker exec "$NAME" bash -lc "$probe" >/dev/null 2>&1 ||
    fail "runtime probe failed in the pre-created posture: $probe" "$NAME"
done
echo "POOL-SMOKE: all baked runtimes resolve in the pre-created posture too"

# ---------------------------------------------------------------------------
# The self-host boot path is untouched
#
# entrypoint.sh is shared with the image self-hosters run, and that mode takes a
# different branch: no firewall, no privilege drop, no command channel. This boots
# that branch WITHOUT the network capability — exactly as the compose stack does —
# and with an assignment credential deliberately present, to show the pre-created
# posture is confined to the runner branch rather than triggered by an environment
# variable leaking across.
#
# The server itself cannot come up on this target (it is the slim build, with no
# api bundle), which is fine: what is asserted here is the dispatch, and the full
# self-host boot is covered against the published image by its own job.
# ---------------------------------------------------------------------------
NAME="skrun-pool-smoke-selfhost-$$"
CONTAINERS+=("$NAME")
docker run -d --name "$NAME" \
  -e SKRUN_CONTAINER_MODE=api-server \
  -e RUNNER_CLAIM_TOKEN="$CLAIM_TOKEN" \
  "$TAG" >/dev/null 2>&1 || true
sleep 3
LOGS=$(docker logs "$NAME" 2>&1 || true)

case "$LOGS" in
  *"self-host mode"*) ;;
  *) fail "the self-host branch was not taken: $LOGS" ;;
esac
case "$LOGS" in
  *"configuring iptables"*) fail "the self-host branch attempted firewall setup" ;;
esac
case "$LOGS" in
  *"assignment channel"*|*"pre-created machine"*)
    fail "the pre-created posture leaked into the self-host branch" ;;
esac
if docker exec "$NAME" test -d /run/skrun-egress 2>/dev/null; then
  fail "a command channel was created on the self-host branch"
fi
echo "POOL-SMOKE: the self-host branch takes no firewall, no privilege drop, no channel"

echo "POOL-SMOKE PASS: runtimes resolve in the pre-created posture, and self-host is untouched."
