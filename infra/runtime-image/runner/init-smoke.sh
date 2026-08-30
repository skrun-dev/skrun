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
# Usage:
#   infra/runtime-image/runner/init-smoke.sh
#   SMOKE_IMAGE=<tag> infra/runtime-image/runner/init-smoke.sh
#
set -euo pipefail

TAG="${SMOKE_IMAGE:-skrun-runtime:smoke}"
NET="skrun-init-smoke-$$"
FIXTURE_HOST="fixture-server"
RUNNER_NAME="skrun-init-smoke-runner-$$"
PORT=9098
WORK="$(mktemp -d)"

command -v docker >/dev/null || {
  echo "INIT-SMOKE: docker not found — run this where Docker is available (CI)."
  exit 3
}

cleanup() {
  docker rm -f "$RUNNER_NAME" "$FIXTURE_HOST" >/dev/null 2>&1 || true
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

docker network create "$NET" >/dev/null

# Static file server, on the runtime image itself (python3 is already baked in).
docker run -d --name "$FIXTURE_HOST" --network "$NET" \
  --entrypoint /bin/bash \
  -v "$WORK/serve:/srv:ro" \
  "$TAG" -c 'cd /srv && exec python3 -m http.server 8000 --bind 0.0.0.0' >/dev/null
echo "INIT-SMOKE: fixture server up on the smoke network"

# The runner. RUNNER_INFRA_HOSTS is what makes the fixture host reachable through
# the default-DROP egress — the same door the object store uses in production.
docker run -d --name "$RUNNER_NAME" --network "$NET" --cap-add=NET_ADMIN \
  -p "$PORT:9000" \
  -e SKRUN_CONTAINER_MODE=runner \
  -e RUNNER_PORT=9000 \
  -e SKRUN_ALLOWED_HOSTS= \
  -e RUNNER_INFRA_HOSTS="$FIXTURE_HOST" \
  "$TAG" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://localhost:$PORT/healthz" >/dev/null || {
  echo "INIT-SMOKE FAIL: runner never became healthy"
  docker logs "$RUNNER_NAME" 2>&1 | tail -40
  exit 1
}
echo "INIT-SMOKE: runner healthy"

# The assertion that matters: /init downloads the bundle THROUGH the sandbox's
# firewall and extracts it.
INIT_BODY=$(cat <<JSON
{"bundleUrl":"http://$FIXTURE_HOST:8000/fixture.agent","tools":[],"mcpServers":[],"allowedHosts":[]}
JSON
)
RESPONSE=$(curl -fsS -X POST "http://localhost:$PORT/init" \
  -H 'Content-Type: application/json' \
  -d "$INIT_BODY" 2>&1) || {
  echo "INIT-SMOKE FAIL: /init request failed"
  echo "  response: $RESPONSE"
  docker logs "$RUNNER_NAME" 2>&1 | tail -40
  exit 1
}

case "$RESPONSE" in
  *'"ok":true'*) ;;
  *)
    echo "INIT-SMOKE FAIL: /init did not report success"
    echo "  response: $RESPONSE"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
    ;;
esac

# The bundle really landed — not just an HTTP 200 with an empty tarball.
docker exec "$RUNNER_NAME" test -f /mnt/agent/agent.yaml || {
  echo "INIT-SMOKE FAIL: bundle extracted but agent.yaml is missing from /mnt/agent"
  exit 1
}

echo "INIT-SMOKE: /init response: $RESPONSE"
echo "INIT-SMOKE PASS: the runner fetched and extracted a bundle through its own egress allowlist."
