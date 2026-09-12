#!/usr/bin/env bash
#
# init-smoke.sh — prove the runner can actually initialise inside CI.
#
# WHY THIS EXISTS
# `smoke.sh` states plainly that the /init phases "need a real agent bundle +
# object store and are exercised by the Level-5 cloud verify, not here" — so until
# now nothing in CI could make /init succeed. That is fine for a boot smoke, but it
# blocks any test that needs the runner to reach the point where it dispatches a
# tool, because a tool needs a bundle to come from.
#
# The obstacle is the sandbox's own firewall: the runner drops outbound traffic by
# default. The way through is the mechanism that already exists for the object
# store — hosts named in RUNNER_INFRA_HOSTS are resolved and allowed at boot, and
# deliberately NOT filtered for private addresses (the harness controls them, and a
# self-hosted store may well be on a private network). A container on the same
# Docker network is exactly that shape.
#
#   fixture-server (static file server)  <--- allowed via RUNNER_INFRA_HOSTS
#           |
#      docker network
#           |
#   runner (OUTPUT DROP + the allowances the entrypoint installs)
#
# The file server runs the runtime image itself with a shell entrypoint, so no
# second image is pulled and nothing new enters the build.
#
# WHAT IT ASSERTS — three cases, one runner each
# A runner initialises exactly once ("runner already initialized"), so each case
# needs its own container. All three fetch the SAME fixture bundle; what differs
# is the checksum the /init body carries:
#
#   1. matching checksum   -> initialises, bundle on disk, and no "unverified"
#                             line in the log (which is what proves the field was
#                             read rather than ignored)
#   2. differing checksum  -> the request FAILS and /mnt/agent/agent.yaml does
#                             NOT exist — refused BEFORE extraction, not after
#   3. no checksum at all  -> initialises as before, and says so in its log
#
# Usage:
#   infra/runtime-image/runner/init-smoke.sh
#   SMOKE_IMAGE=<tag> infra/runtime-image/runner/init-smoke.sh
#
set -euo pipefail

TAG="${SMOKE_IMAGE:-skrun-runtime:smoke}"
NET="skrun-init-smoke-$$"
FIXTURE_HOST="fixture-server"
RUNNER_PREFIX="skrun-init-smoke-runner-$$"
WORK="$(mktemp -d)"
# Space-separated so cleanup works under `set -u` with none started yet.
RUNNERS=""
NEXT_PORT=9098
# The unverified-bundle line the runner writes when the body carries no
# checksum. Case 3 requires it; case 1 requires its absence.
UNVERIFIED_LINE="bundle served without a checksum"

command -v docker >/dev/null || {
  echo "INIT-SMOKE: docker not found — run this where Docker is available (CI)."
  exit 3
}

cleanup() {
  for r in $RUNNERS; do
    docker rm -f "$r" >/dev/null 2>&1 || true
  done
  docker rm -f "$FIXTURE_HOST" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# A minimal agent bundle. /init downloads it and untars it; that is all it needs
# to succeed with no tools declared. A tool-bearing fixture belongs to the test
# that needs one, not here — this script proves the PATH works.
# ---------------------------------------------------------------------------
mkdir -p "$WORK/bundle/scripts"
printf 'name: init-smoke\nversion: 1.0.0\n' > "$WORK/bundle/agent.yaml"
printf '# init smoke fixture\n' > "$WORK/bundle/SKILL.md"
mkdir -p "$WORK/serve"
tar -czf "$WORK/serve/fixture.agent" -C "$WORK/bundle" .
echo "INIT-SMOKE: fixture bundle built ($(stat -c%s "$WORK/serve/fixture.agent") bytes)"

BUNDLE_SHA256="$(sha256sum "$WORK/serve/fixture.agent" | cut -d' ' -f1)"
# The wrong checksum is the right one with a single character changed: same
# length, still hex, so what rejects it is the comparison and not the shape.
# A malformed string would be turned away by the body schema and would prove
# nothing about the check this script is here for.
case "${BUNDLE_SHA256:0:1}" in
  0) WRONG_SHA256="1${BUNDLE_SHA256:1}" ;;
  *) WRONG_SHA256="0${BUNDLE_SHA256:1}" ;;
esac
echo "INIT-SMOKE: fixture checksum ${BUNDLE_SHA256:0:12}... (mismatch case uses ${WRONG_SHA256:0:12}...)"

docker network create "$NET" >/dev/null

# Static file server, on the runtime image itself (python3 is already baked in).
docker run -d --name "$FIXTURE_HOST" --network "$NET" \
  --entrypoint /bin/bash \
  -v "$WORK/serve:/srv:ro" \
  "$TAG" -c 'cd /srv && exec python3 -m http.server 8000 --bind 0.0.0.0' >/dev/null
echo "INIT-SMOKE: fixture server up on the smoke network"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Start a fresh runner and wait for /healthz. Sets RUNNER_NAME + RUNNER_PORT.
# RUNNER_INFRA_HOSTS is what makes the fixture host reachable through the
# default-DROP egress — the same door the object store uses in production.
start_runner() {
  RUNNER_NAME="$RUNNER_PREFIX-$1"
  RUNNER_PORT="$NEXT_PORT"
  NEXT_PORT=$((NEXT_PORT + 1))
  RUNNERS="$RUNNERS $RUNNER_NAME"

  docker run -d --name "$RUNNER_NAME" --network "$NET" --cap-add=NET_ADMIN \
    -p "$RUNNER_PORT:9000" \
    -e SKRUN_CONTAINER_MODE=runner \
    -e RUNNER_PORT=9000 \
    -e SKRUN_ALLOWED_HOSTS= \
    -e RUNNER_INFRA_HOSTS="$FIXTURE_HOST" \
    "$TAG" >/dev/null

  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:$RUNNER_PORT/healthz" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl -fsS "http://localhost:$RUNNER_PORT/healthz" >/dev/null || {
    echo "INIT-SMOKE FAIL: runner $RUNNER_NAME never became healthy"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
  }
  echo "INIT-SMOKE: runner $1 healthy on port $RUNNER_PORT"
}

# An /init body for the fixture bundle. With an argument, it carries that
# checksum; without one, the field is absent entirely — which is what an older
# harness, or a bundle published before checksums were recorded, looks like.
init_body() {
  if [ "$#" -gt 0 ]; then
    printf '{"bundleUrl":"http://%s:8000/fixture.agent","tools":[],"mcpServers":[],"allowedHosts":[],"bundleSha256":"%s"}' \
      "$FIXTURE_HOST" "$1"
  else
    printf '{"bundleUrl":"http://%s:8000/fixture.agent","tools":[],"mcpServers":[],"allowedHosts":[]}' \
      "$FIXTURE_HOST"
  fi
}

# POST an /init body, write the response to $2, echo the HTTP status. No -f:
# a refusal is an expected outcome here, and its body is the interesting part.
post_init() {
  curl -sS -o "$2" -w '%{http_code}' -X POST "http://localhost:$RUNNER_PORT/init" \
    -H 'Content-Type: application/json' \
    -d "$1"
}

# ---------------------------------------------------------------------------
# Case 1 — a matching checksum initialises normally
# ---------------------------------------------------------------------------
start_runner match
CODE=$(post_init "$(init_body "$BUNDLE_SHA256")" "$WORK/match.json")
BODY=$(cat "$WORK/match.json")
[ "$CODE" = "200" ] || {
  echo "INIT-SMOKE FAIL: /init with a matching checksum answered HTTP $CODE"
  echo "  response: $BODY"
  docker logs "$RUNNER_NAME" 2>&1 | tail -40
  exit 1
}
case "$BODY" in
  *'"ok":true'*) ;;
  *)
    echo "INIT-SMOKE FAIL: /init did not report success"
    echo "  response: $BODY"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
    ;;
esac

# The bundle really landed — not just an HTTP 200 with an empty tarball.
docker exec "$RUNNER_NAME" test -f /mnt/agent/agent.yaml || {
  echo "INIT-SMOKE FAIL: bundle extracted but agent.yaml is missing from /mnt/agent"
  exit 1
}

# And it was checked rather than waved through. Without this, case 1 would pass
# just as well against a runner that ignored the field — the success it asserts
# does not depend on the checksum being read.
if docker logs "$RUNNER_NAME" 2>&1 | grep -q "$UNVERIFIED_LINE"; then
  echo "INIT-SMOKE FAIL: a checksum was sent, yet the runner logged the bundle as unverified"
  docker logs "$RUNNER_NAME" 2>&1 | grep "$UNVERIFIED_LINE"
  exit 1
fi
echo "INIT-SMOKE: /init response: $BODY"
echo "INIT-SMOKE: case 1 PASS — matching checksum, bundle extracted, nothing logged as unverified"

# ---------------------------------------------------------------------------
# Case 2 — a differing checksum is refused BEFORE extraction
# ---------------------------------------------------------------------------
start_runner mismatch
CODE=$(post_init "$(init_body "$WRONG_SHA256")" "$WORK/mismatch.json")
BODY=$(cat "$WORK/mismatch.json")
case "$CODE" in
  2*)
    echo "INIT-SMOKE FAIL: /init accepted a bundle whose checksum does not match (HTTP $CODE)"
    echo "  response: $BODY"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
    ;;
esac
case "$BODY" in
  *'checksum mismatch'*) ;;
  *)
    echo "INIT-SMOKE FAIL: /init refused the bundle without saying the checksum was the reason"
    echo "  response: $BODY"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
    ;;
esac

# The point of the whole case: refused BEFORE extraction, not after. A check
# that ran afterwards would leave the scripts it rejects on disk, where the tool
# runner reads from.
docker exec "$RUNNER_NAME" test ! -f /mnt/agent/agent.yaml || {
  echo "INIT-SMOKE FAIL: the bundle was refused but /mnt/agent/agent.yaml exists — extracted first, refused after"
  docker exec "$RUNNER_NAME" ls -la /mnt/agent 2>&1 | tail -20
  exit 1
}
echo "INIT-SMOKE: /init refusal: $BODY"
echo "INIT-SMOKE: case 2 PASS — mismatch refused, and nothing was written to /mnt/agent"

# ---------------------------------------------------------------------------
# Case 3 — a body with no checksum still runs, and says so
# ---------------------------------------------------------------------------
start_runner nochecksum
CODE=$(post_init "$(init_body)" "$WORK/nochecksum.json")
BODY=$(cat "$WORK/nochecksum.json")
[ "$CODE" = "200" ] || {
  echo "INIT-SMOKE FAIL: /init without a checksum answered HTTP $CODE — an older bundle must stay runnable"
  echo "  response: $BODY"
  docker logs "$RUNNER_NAME" 2>&1 | tail -40
  exit 1
}
case "$BODY" in
  *'"ok":true'*) ;;
  *)
    echo "INIT-SMOKE FAIL: /init without a checksum did not report success"
    echo "  response: $BODY"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
    ;;
esac
docker exec "$RUNNER_NAME" test -f /mnt/agent/agent.yaml || {
  echo "INIT-SMOKE FAIL: no checksum was sent and the bundle was not extracted either"
  exit 1
}
# Running unverified is allowed; running unverified in silence is not.
TRACE=$(docker logs "$RUNNER_NAME" 2>&1 | grep "$UNVERIFIED_LINE" || true)
[ -n "$TRACE" ] || {
  echo "INIT-SMOKE FAIL: the bundle was extracted unverified without a word in the log"
  docker logs "$RUNNER_NAME" 2>&1 | tail -40
  exit 1
}
echo "INIT-SMOKE: log line: $TRACE"
echo "INIT-SMOKE: case 3 PASS — no checksum, still runnable, and the log says it was unverified"

echo "INIT-SMOKE PASS: the runner fetched a bundle through its own egress allowlist, extracted it when the checksum matched, refused it before extraction when it did not, and reported the case where none was supplied."
