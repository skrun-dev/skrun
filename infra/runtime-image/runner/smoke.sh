#!/usr/bin/env bash
#
# Runner cold-start-telemetry boot smoke — a fast local trip-wire that a change
# to entrypoint.sh or the runner didn't break the boot + marker path, without
# waiting for the Level-5 cloud verify.
#
# Asserts, at the container level:
#   1. the image builds (which runs the runner's `tsc`),
#   2. the entrypoint (uid 0) writes the world-readable boot marker,
#   3. the OUTPUT egress policy is applied (the timing edit left it intact),
#   4. the runner (uid 1000, post-capsh) reads /proc/uptime + the marker and
#      serves /healthz.
#
# The /init phase timings (bundle/extract/mcp) need a real agent bundle + object
# store and are exercised by the Level-5 cloud verify, not here.
#
# Requires Docker with --cap-add=NET_ADMIN (the entrypoint configures iptables).
# Set SMOKE_IMAGE=<tag> to reuse a prebuilt dev image and skip the (slow)
# multi-runtime build — e.g. during a Phase-6 cloud verify.
#
#   infra/runtime-image/runner/smoke.sh
#   SMOKE_IMAGE=ghcr.io/skrun-dev/skrun-runtime:0.9.0-devN infra/runtime-image/runner/smoke.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMG_CTX="$REPO_ROOT/infra/runtime-image"
TAG="${SMOKE_IMAGE:-skrun-runtime:smoke}"
PORT=9099
NAME="skrun-runner-smoke-$$"

command -v docker >/dev/null || {
  echo "SMOKE: docker not found — run this where Docker is available (CI / operator env)."
  exit 3
}

built_here=0
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [[ "$built_here" == 1 ]]; then
    rm -f "$IMG_CTX"/skrun-dev-runtime.tgz
  fi
}
trap cleanup EXIT

if [[ -z "${SMOKE_IMAGE:-}" ]]; then
  built_here=1
  echo "SMOKE: packing the runtime tarball into the build context (runner target only)..."
  ( cd "$REPO_ROOT" \
    && pnpm --filter @skrun-dev/runtime pack --pack-destination "$IMG_CTX" >/dev/null )
  # pnpm writes <name>-<version>.tgz; the Dockerfile ARG defaults to the
  # unversioned name, so normalise. The `runner` target needs ONLY the runtime
  # tarball (no schema/api — schema resolves from npm, api is api-server-only).
  mv "$IMG_CTX"/skrun-dev-runtime-*.tgz "$IMG_CTX/skrun-dev-runtime.tgz"
  echo "SMOKE: building the runner target (runs the runner tsc)..."
  docker build --target runner -t "$TAG" "$IMG_CTX" >/dev/null
else
  echo "SMOKE: using prebuilt image $TAG (skipping build)."
fi

echo "SMOKE: booting the runner (NET_ADMIN for the egress setup)..."
docker run -d --name "$NAME" --cap-add=NET_ADMIN \
  -e SKRUN_CONTAINER_MODE=runner \
  -e SKRUN_ALLOWED_HOSTS=example.com \
  -e RUNNER_PORT="$PORT" \
  -p "$PORT:$PORT" "$TAG" >/dev/null

echo "SMOKE: waiting for /healthz..."
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
if [[ "$ok" != 1 ]]; then
  echo "SMOKE FAIL: /healthz never came up"
  docker logs "$NAME" 2>&1 | tail -40
  exit 1
fi
echo "SMOKE: /healthz 200 OK"

echo "SMOKE: asserting the egress policy is applied (OUTPUT DROP — timing edit left it intact)..."
docker exec "$NAME" iptables -L OUTPUT -n 2>/dev/null | grep -q 'policy DROP' || {
  echo "SMOKE FAIL: OUTPUT policy is not DROP — the egress setup regressed"
  exit 1
}

echo "SMOKE: asserting the boot marker is written + readable by the runner uid (1000)..."
marker="$(docker exec -u 1000 "$NAME" cat /tmp/skrun-boot.json 2>/dev/null || true)"
echo "$marker" | grep -q 'egress_ms' || {
  echo "SMOKE FAIL: boot marker missing or unreadable by uid 1000 (got: '$marker')"
  exit 1
}
echo "SMOKE: boot marker OK ($marker)"

echo "SMOKE: asserting the runner target is SLIM (no api-server bundle / dashboard / build-essential)..."
docker exec "$NAME" sh -c 'test ! -e /opt/skrun-api' || { echo "SMOKE FAIL: /opt/skrun-api present in the runner target"; exit 1; }
docker exec "$NAME" sh -c 'test ! -e /opt/skrun-web' || { echo "SMOKE FAIL: /opt/skrun-web present in the runner target"; exit 1; }
docker exec "$NAME" sh -c '! command -v gcc >/dev/null 2>&1' || { echo "SMOKE FAIL: gcc/build-essential present in the runner target"; exit 1; }
echo "SMOKE: runner is slim — api-server bundle + dashboard + build-essential all absent"

echo "SMOKE PASS: runner builds, boots, keeps the egress policy, writes+reads the boot marker, serves /healthz, and is slim."
