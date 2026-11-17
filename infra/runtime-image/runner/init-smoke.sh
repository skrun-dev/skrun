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
# WHAT IT ASSERTS — thirteen cases, one runner each
# A runner initialises exactly once ("runner already initialized"), so each case
# needs its own container. The first three fetch the SAME fixture bundle; what
# differs is the checksum the /init body carries:
#
#   1. matching checksum   -> initialises, bundle on disk, and no "unverified"
#                             line in the log (which is what proves the field was
#                             read rather than ignored)
#   2. differing checksum  -> the request FAILS, naming the checksum as its step,
#                             and /mnt/agent/agent.yaml does NOT exist — refused
#                             BEFORE extraction, not after
#   3. no checksum at all  -> initialises as before, and says so in its log
#
# The last four fetch bundles whose scripts declare dependencies. Their runners
# are also let through to the public package registries, the list the harness
# passes in production, read from the runtime the image ships — so these cases
# install real packages over the network:
#
#   4. a Python requirement -> /init installs it and reports how long it took, the
#                             script imports it, and the runner's HOME is its own
#                             writable directory
#   5. a package that does not exist -> /init still succeeds; the tool call
#                             returns the typed install failure, never a bare
#                             missing module, and the runner logs the failure
#   6. a Node dependency, imported by an ES-module .ts script -> the bundle root
#                             gets a node_modules link into the install, and the
#                             import resolves through it
#   7. an install that fails after printing the URL the bundle was fetched from
#                             -> the runner's failure line carries none of that
#                             URL: not the whole of it, and not the end of it
#                             either, where the line's length limit cuts the
#                             output in the middle of the URL
#
# The last two are about what a run hands back:
#
#   8. the files a run leaves -> 28 of them, written where a run writes: one of
#                             11 MiB, one empty, one whose name holds a control
#                             character, 20 of 1 KiB at the top and 5 more in a
#                             subdirectory. The list keeps the limits it is sent
#                             (20 files of at most 10 MiB: the empty one and the
#                             first 19 by path) and counts what it leaves out,
#                             by reason; it applies limits other than the
#                             defaults too, takes the defaults for an empty
#                             body, and refuses limits it cannot accept. A file
#                             is served within the size limit of the last list:
#                             one that grew since as the bytes it was listed
#                             at, an empty one as nothing, 1 MiB whole, a
#                             larger one not at all, and one that shrinks
#                             while it is served cut at once, its connection
#                             closed — and the runner still answers after each
#   9. tool results far past the bound on an answer -> a script that prints
#                             3 MiB, and one that fails with 3 MiB of error
#                             output: each answer stays within the bound, is
#                             valid JSON, and ends with the marker that tells
#                             the model it was cut
#
# Unlike the first seven, cases 8 and 9 report every check that fails before
# the script stops, so that one run shows all of what a runner gets wrong.
#
# The next one is about a bundle that never arrives whole:
#
#  10. a bundle server that cuts the connection in the middle of the body ->
#                             /init FAILS, naming the incomplete download as its
#                             step; the runner is still up and answering, and no
#                             partial archive is left on its disk
#
# The last three are about an extraction that fails, which the harness judges by
# its step: the bundle's own fault, or not.
#
#  11. a bundle that is not a gzip, its checksum the right one -> /init FAILS,
#                             naming the extraction as its step — the bundle's
#                             fault, which another machine would meet again
#  12. a bundle that extracts more than its disk holds -> /init FAILS, naming a
#                             full disk as its step, not the extraction: no fault
#                             of the bundle's
#  13. a tar ended by a signal -> /init FAILS, its step not the extraction: tar
#                             said nothing of the bundle. A tar of the case's own,
#                             first in the runner's PATH, ends itself by SIGKILL
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

# ---------------------------------------------------------------------------
# Bundles whose scripts declare dependencies (cases 4-6). Each is a real agent
# layout: a manifest at the bundle root, the script under scripts/.
# ---------------------------------------------------------------------------
# pack_bundle <name> — tar $WORK/<name>/ into $WORK/serve/<name>.agent
pack_bundle() {
  tar -czf "$WORK/serve/$1.agent" -C "$WORK/$1" .
}

# A small pure-Python wheel, pinned; the script prints the version it imported.
mkdir -p "$WORK/py-deps/scripts"
printf 'name: init-smoke-py\nversion: 1.0.0\n' > "$WORK/py-deps/agent.yaml"
printf 'six==1.16.0\n' > "$WORK/py-deps/requirements.txt"
printf 'import six\nprint(six.__version__)\n' > "$WORK/py-deps/scripts/six_version.py"
pack_bundle py-deps

# The same script, but its requirement cannot be found on the index.
mkdir -p "$WORK/py-missing/scripts"
printf 'name: init-smoke-py-missing\nversion: 1.0.0\n' > "$WORK/py-missing/agent.yaml"
printf 'skrun-init-smoke-no-such-package==0.0.1\n' > "$WORK/py-missing/requirements.txt"
cp "$WORK/py-deps/scripts/six_version.py" "$WORK/py-missing/scripts/six_version.py"
pack_bundle py-missing

# A Node dependency imported the way agent scripts do it: an ES `import` in a
# .ts file. ES modules ignore NODE_PATH, so this resolves only through a
# node_modules directory above the script.
mkdir -p "$WORK/node-deps/scripts"
printf 'name: init-smoke-node\nversion: 1.0.0\n' > "$WORK/node-deps/agent.yaml"
printf '{"name":"init-smoke-node","private":true,"dependencies":{"ms":"2.1.3"}}\n' \
  > "$WORK/node-deps/package.json"
printf 'import ms from "ms";\nconst value: number = ms("2h");\nprocess.stdout.write(String(value));\n' \
  > "$WORK/node-deps/scripts/ms_value.ts"
pack_bundle node-deps
echo "INIT-SMOKE: dependency bundles built (python, python with a missing package, node)"

# The registries a runner may install from, as the harness lists them: read from
# the runtime the image ships rather than copied here.
INSTALL_REGISTRIES="$(docker run --rm --entrypoint node "$TAG" --input-type=module -e '
  const m = await import("/opt/skrun-runner/node_modules/@skrun-dev/runtime/dist/tools/script-deps-installers.js");
  process.stdout.write(m.INSTALL_REGISTRY_ALLOWLIST.join(","));
')"
[ -n "$INSTALL_REGISTRIES" ] || {
  echo "INIT-SMOKE FAIL: could not read the install registries from the image's runtime"
  exit 1
}
echo "INIT-SMOKE: install registries: $INSTALL_REGISTRIES"

# ---------------------------------------------------------------------------
# A Node bundle whose install fails after printing, on its error output, the URL
# the runner fetched the bundle from (case 7). In production that URL is
# presigned: whoever holds it can read the bundle until it expires, and an
# installer runs code from the packages it installs. The runner keeps only the
# end of a failed installer's output for its log line; the first print below is
# sized so that this end begins in the middle of the URL.
# ---------------------------------------------------------------------------
# How much of that output the runner keeps, read from the runner the image ships.
TAIL_CHARS="$(docker run --rm --entrypoint sh "$TAG" -c \
  "grep -o 'DEPS_FAILURE_TAIL_CHARS = [0-9]*' /opt/skrun-runner/dist/dispatch.js | head -1 | tr -dc 0-9")"
[ -n "$TAIL_CHARS" ] || {
  echo "INIT-SMOKE FAIL: could not read the runner's failure-output limit from the image"
  exit 1
}

# The bundle's URL in the shape of a presigned one, query and signature included.
# The fixture server ignores the query and serves the file.
SIGNATURE="$(printf 'init smoke presigned url' | sha256sum | cut -c1-64)"
PRESIGNED_URL="http://$FIXTURE_HOST:8000/node-fail.agent?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=init-smoke%2F20261001%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261001T000000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&x-id=GetObject&X-Amz-Signature=$SIGNATURE"
URL_LEN=${#PRESIGNED_URL}

# The root package's preinstall script, which npm runs: it prints two lines on
# its error output, then fails.
#   - filler, the URL, filler. The filler after the URL is sized so that the
#     kept end of the output starts halfway through the URL. The filler before
#     it is long enough that, once the URL is blanked to a short marker, the
#     kept end still starts before that marker.
#   - "fetching " and the URL, whole.
# npm then adds lines of its own: five, about 300 characters plus the command
# they repeat. That is an estimate; the case checks where the cut really fell.
FAIL_SCRIPT="node -e 'const c=require(process.env.npm_package_json).config;const n=String.fromCharCode(10);process.stderr.write(c.lead.repeat(c.before)+c.url+c.trail.repeat(c.after)+n+c.again+c.url+n);process.exit(1)'"
FAIL_AGAIN="fetching "
NPM_LINES_LEN=$((300 + ${#FAIL_SCRIPT}))
FILL_AFTER=$((TAIL_CHARS - URL_LEN / 2 - (1 + ${#FAIL_AGAIN} + URL_LEN + 1) - NPM_LINES_LEN))
FILL_BEFORE=$((2 * URL_LEN))
[ "$FILL_AFTER" -gt 0 ] || {
  echo "INIT-SMOKE FAIL: a limit of $TAIL_CHARS characters leaves no room to cut through a $URL_LEN-character URL"
  exit 1
}
mkdir -p "$WORK/node-fail/scripts"
printf 'name: init-smoke-node-fail\nversion: 1.0.0\n' > "$WORK/node-fail/agent.yaml"
printf '{"name":"init-smoke-node-fail","private":true,"scripts":{"preinstall":"%s"},"config":{"url":"%s","lead":"a","before":%d,"trail":"z","after":%d,"again":"%s"}}\n' \
  "$FAIL_SCRIPT" "$PRESIGNED_URL" "$FILL_BEFORE" "$FILL_AFTER" "$FAIL_AGAIN" \
  > "$WORK/node-fail/package.json"
cp "$WORK/node-deps/scripts/ms_value.ts" "$WORK/node-fail/scripts/ms_value.ts"
pack_bundle node-fail
echo "INIT-SMOKE: failing install bundle built (URL of $URL_LEN characters, output limit $TAIL_CHARS)"

# ---------------------------------------------------------------------------
# A bundle with two script tools whose results are far past the bound on a
# tool's answer (case 9): one prints 3 MiB, the other raises an error whose
# message is 3 MiB — a script that fails answers with its error output.
# ---------------------------------------------------------------------------
mkdir -p "$WORK/big-results/scripts"
printf 'name: init-smoke-big-results\nversion: 1.0.0\n' > "$WORK/big-results/agent.yaml"
printf 'import sys\nsys.stdout.write("r" * 3 * 1024 * 1024)\n' > "$WORK/big-results/scripts/big_result.py"
printf 'raise RuntimeError("e" * 3 * 1024 * 1024)\n' > "$WORK/big-results/scripts/big_error.py"
pack_bundle big-results
echo "INIT-SMOKE: large results bundle built (a 3 MiB result, a 3 MiB error)"

# ---------------------------------------------------------------------------
# The extraction's failures (cases 11-13): a bundle whose bytes are no archive at
# all; one that extracts a 1 MiB file, more than the small disk its runner gets
# holds; and, for the fixture bundle, a tar that ends itself by a signal.
# ---------------------------------------------------------------------------
printf 'this is not a gzip archive\n' > "$WORK/serve/not-gzip.agent"
mkdir -p "$WORK/big-file"
printf 'name: init-smoke-big-file\nversion: 1.0.0\n' > "$WORK/big-file/agent.yaml"
head -c 1048576 /dev/zero > "$WORK/big-file/zeros.bin"
pack_bundle big-file
# The disk case's runner gets this much room for the bundle's files.
DISK_FULL_TMPFS_SIZE=128k
mkdir -p "$WORK/killed-tar"
printf '#!/bin/sh\n# A tar ended by a signal before it reads anything.\nkill -KILL $$\n' > "$WORK/killed-tar/tar"
chmod 0755 "$WORK/killed-tar/tar"
echo "INIT-SMOKE: extraction bundles built (not a gzip; a 1 MiB file for a $DISK_FULL_TMPFS_SIZE disk) and a tar that kills itself"

# The module the runner takes its output and answer rules from, in the runtime
# the image ships: case 9 reads the bound on an answer and the marker from it
# rather than copy them.
OUTPUT_RULES_MODULE="/opt/skrun-runner/node_modules/@skrun-dev/runtime/dist/files/output-rules.js"

# ---------------------------------------------------------------------------
# A bundle server that cuts every answer in the middle of its body (case 10):
# it announces 1 MiB, sends 64 KiB, and resets the connection. It runs next to
# the static server, on another port of the same host, which the runner's
# egress already lets through.
# ---------------------------------------------------------------------------
CUT_PORT=8001
CUT_DECLARED_BYTES=1048576
mkdir -p "$WORK/cut"
cat > "$WORK/cut/cut-server.py" <<'PY'
import socket
import struct
import sys
import time

port, declared = int(sys.argv[1]), int(sys.argv[2])
head = (
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: application/gzip\r\n"
    f"Content-Length: {declared}\r\n"
    "Connection: close\r\n\r\n"
).encode()
with socket.create_server(("0.0.0.0", port)) as server:
    while True:
        conn, _ = server.accept()
        conn.recv(65536)
        conn.sendall(head + b"\0" * 65536)
        # Long enough for the client to read the head and start on the body: a
        # reset that came first would drop the head with it, and the download
        # would fail for want of an answer instead of in the middle of one.
        time.sleep(0.5)
        # A linger of zero: close() resets the connection instead of ending it.
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        conn.close()
PY

docker network create "$NET" >/dev/null

# Static file server, on the runtime image itself (python3 is already baked in),
# and the server that cuts its answers beside it.
docker run -d --name "$FIXTURE_HOST" --network "$NET" \
  --entrypoint /bin/bash \
  -v "$WORK/serve:/srv:ro" \
  -v "$WORK/cut:/cut:ro" \
  "$TAG" -c "python3 /cut/cut-server.py $CUT_PORT $CUT_DECLARED_BYTES & cd /srv && exec python3 -m http.server 8000 --bind 0.0.0.0" >/dev/null
echo "INIT-SMOKE: fixture server up on the smoke network (and the cutting one on port $CUT_PORT)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Start a fresh runner and wait for /healthz. Sets RUNNER_NAME + RUNNER_PORT.
# RUNNER_INFRA_HOSTS is what makes the fixture host reachable through the
# default-DROP egress — the same door the object store uses in production. A
# second argument, when not empty, adds hosts to it (the install registries, for
# cases 4-6); the arguments after it are docker run options (cases 12 and 13).
# The runner runs as it does on a machine: the shipped entrypoint, the drop to
# the unprivileged user, a writable root filesystem.
start_runner() {
  RUNNER_NAME="$RUNNER_PREFIX-$1"
  RUNNER_PORT="$NEXT_PORT"
  NEXT_PORT=$((NEXT_PORT + 1))
  RUNNERS="$RUNNERS $RUNNER_NAME"
  local infra_hosts="$FIXTURE_HOST"
  if [ -n "${2:-}" ]; then infra_hosts="$FIXTURE_HOST,$2"; fi
  local -a options=()
  if [ "$#" -gt 2 ]; then options=("${@:3}"); fi

  docker run -d --name "$RUNNER_NAME" --network "$NET" --cap-add=NET_ADMIN \
    -p "$RUNNER_PORT:9000" \
    -e SKRUN_CONTAINER_MODE=runner \
    -e RUNNER_PORT=9000 \
    -e SKRUN_ALLOWED_HOSTS= \
    -e RUNNER_INFRA_HOSTS="$infra_hosts" \
    "${options[@]}" \
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

# An /init body for one of the dependency bundles, declaring its one script tool.
# A third argument replaces the bundle's plain URL.
# deps_init_body <bundle> <tool> [<url>]
deps_init_body() {
  local sha url
  sha="$(sha256sum "$WORK/serve/$1.agent" | cut -d' ' -f1)"
  url="${3:-http://$FIXTURE_HOST:8000/$1.agent}"
  printf '{"bundleUrl":"%s","tools":[{"name":"%s","description":"init smoke","input_schema":{"type":"object","properties":{},"additionalProperties":true}}],"mcpServers":[],"allowedHosts":[],"bundleSha256":"%s"}' \
    "$url" "$2" "$sha"
}

# POST a script tool call with no arguments, write the response to $2, echo the
# HTTP status.
post_tool() {
  curl -sS -o "$2" -w '%{http_code}' -X POST "http://localhost:$RUNNER_PORT/tool" \
    -H 'Content-Type: application/json' \
    -d "{\"kind\":\"script\",\"name\":\"$1\",\"args\":{}}"
}

# deps_ms from an /init response body; empty when the runner did not report it.
deps_ms_of() {
  sed -n 's/.*"deps_ms":\([0-9][0-9]*\).*/\1/p' "$1"
}

# Initialise the current runner with a dependency bundle and require a success.
# init_deps_bundle <bundle> <tool> <response-file> [<url>]
init_deps_bundle() {
  local code
  code=$(post_init "$(deps_init_body "$1" "$2" "${4:-}")" "$3")
  [ "$code" = "200" ] || {
    echo "INIT-SMOKE FAIL: /init with the $1 bundle answered HTTP $code"
    echo "  response: $(cat "$3")"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
  }
}

# Cases 8 and 9 check several things each and report every failed check, then
# the script stops after case 9 when any did.
CHECK_FAILURES=0
# check_fail <case> <what>
check_fail() {
  echo "INIT-SMOKE FAIL: case $1 — $2"
  CHECK_FAILURES=$((CHECK_FAILURES + 1))
}

# POST /outputs/collect with the body given, or with none when it is empty;
# write the response to $2, echo the HTTP status.
post_collect() {
  if [ -n "$1" ]; then
    curl -sS -o "$2" -w '%{http_code}' -X POST "http://localhost:$RUNNER_PORT/outputs/collect" \
      -H 'Content-Type: application/json' -d "$1"
  else
    curl -sS -o "$2" -w '%{http_code}' -X POST "http://localhost:$RUNNER_PORT/outputs/collect"
  fi
}

# What a collect response lists, read by the runner's own node: the paths as a
# JSON array, a space, then the exclusion counts by reason (null when it gives
# none), or "unreadable".
collect_summary() {
  docker exec -i "$RUNNER_NAME" node -e '
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const e = body.excluded;
        const counts = e
          ? { name_refused: e.name_refused, too_large: e.too_large, over_count: e.over_count }
          : null;
        process.stdout.write(`${JSON.stringify(body.files.map((f) => f.path))} ${JSON.stringify(counts)}`);
      } catch {
        process.stdout.write("unreadable");
      }
    });
  ' < "$1"
}

# GET /outputs/file for a path; the body to $2, the headers to $2.headers; echo
# the HTTP status, and curl's exit code when the transfer failed — a check that
# fails, not the end of the script. Both files are created first: curl writes
# none for an empty body, or for a connection that drops.
get_output() {
  local code
  : > "$2"
  : > "$2.headers"
  code=$(curl -sS -o "$2" -D "$2.headers" -w '%{http_code}' \
    "http://localhost:$RUNNER_PORT/outputs/file?path=$1") || code="$code (curl exit $?)"
  echo "$code"
}

# The Content-Length a response written by get_output announced.
content_length_of() {
  tr -d '\r' < "$1.headers" | sed -n 's/^[Cc]ontent-[Ll]ength: *//p' | tail -1
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
# The step the harness reads, not the text: the refusal names the checksum.
case "$BODY" in
  *'"stage":"bundle-checksum"'*) ;;
  *)
    echo "INIT-SMOKE FAIL: /init refused the bundle without naming the checksum as the step that failed"
    echo "  response: $BODY"
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

# ---------------------------------------------------------------------------
# Case 4 — a declared Python dependency is installed at /init, and the script
# imports it
# ---------------------------------------------------------------------------
start_runner py-deps "$INSTALL_REGISTRIES"
init_deps_bundle py-deps six_version "$WORK/py-deps-init.json"
echo "INIT-SMOKE: /init response: $(cat "$WORK/py-deps-init.json")"

# The script first: a runner that never installed anything still answers /init,
# and this is where that shows — a missing module, not the version.
CODE=$(post_tool six_version "$WORK/py-deps-tool.json")
BODY=$(cat "$WORK/py-deps-tool.json")
case "$CODE:$BODY" in
  200:*'"content":"1.16.0"'*'"isError":false'*) ;;
  *)
    echo "INIT-SMOKE FAIL: the script did not run with its declared dependency (HTTP $CODE)"
    echo "  response: $BODY"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
    ;;
esac

DEPS_MS=$(deps_ms_of "$WORK/py-deps-init.json")
[ -n "$DEPS_MS" ] && [ "$DEPS_MS" -gt 0 ] || {
  echo "INIT-SMOKE FAIL: /init did not report the time spent installing (deps_ms: '${DEPS_MS}')"
  exit 1
}

# The runner's HOME — and with it the npm and pip caches of everything it
# starts — is its own directory, created by the unprivileged user, mode 0700.
# Read from the process itself, as that user, not from the start script.
RUNNER_PID=$(docker exec "$RUNNER_NAME" pgrep -f 'node /opt/skrun-runner/dist/index.js' | head -1 || true)
RUNNER_HOME=$(docker exec -u 1000 "$RUNNER_NAME" sh -c "tr '\\0' '\\n' < /proc/$RUNNER_PID/environ | sed -n 's/^HOME=//p'" || true)
HOME_STAT=$(docker exec "$RUNNER_NAME" stat -c '%u %a %F' "$RUNNER_HOME" 2>&1 || true)
[ "$RUNNER_HOME" = "/tmp/skrun-home" ] && [ "$HOME_STAT" = "1000 700 directory" ] || {
  echo "INIT-SMOKE FAIL: the runner's HOME is '$RUNNER_HOME' ($HOME_STAT), expected /tmp/skrun-home (1000 700 directory)"
  exit 1
}
echo "INIT-SMOKE: case 4 PASS — six 1.16.0 installed at /init in ${DEPS_MS} ms, imported by the script; runner HOME $RUNNER_HOME ($HOME_STAT)"

# ---------------------------------------------------------------------------
# Case 5 — a requirement that cannot be installed: /init succeeds, the tool call
# names the cause, and the runner logs it
# ---------------------------------------------------------------------------
start_runner py-missing "$INSTALL_REGISTRIES"
init_deps_bundle py-missing six_version "$WORK/py-missing-init.json"
CODE=$(post_tool six_version "$WORK/py-missing-tool.json")
BODY=$(cat "$WORK/py-missing-tool.json")
case "$CODE:$BODY" in
  *ModuleNotFoundError*)
    echo "INIT-SMOKE FAIL: the script ran without its dependency instead of the install failure being returned"
    echo "  response: $BODY"
    exit 1
    ;;
  200:*'"content":"[SCRIPT_DEPS_INSTALL_FAILED] '*'"isError":true'*) ;;
  *)
    echo "INIT-SMOKE FAIL: the tool call did not return the typed install failure (HTTP $CODE)"
    echo "  response: $BODY"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
    ;;
esac
FAILURE_LINE=$(docker logs "$RUNNER_NAME" 2>&1 | grep 'deps_install_failed' || true)
case "$FAILURE_LINE" in
  *'"ecosystem":"python"'*'"stderr_tail":"'*skrun-init-smoke-no-such-package*) ;;
  *)
    echo "INIT-SMOKE FAIL: no deps_install_failed line naming the ecosystem and the installer's output"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
    ;;
esac
echo "INIT-SMOKE: tool result: $BODY"
echo "INIT-SMOKE: log line: $FAILURE_LINE"
echo "INIT-SMOKE: case 5 PASS — an uninstallable requirement is a typed tool failure and a log line, never a missing module"

# ---------------------------------------------------------------------------
# Case 6 — a Node dependency imported by an ES-module .ts script, through the
# node_modules link at the bundle root
# ---------------------------------------------------------------------------
start_runner node-deps "$INSTALL_REGISTRIES"
init_deps_bundle node-deps ms_value "$WORK/node-deps-init.json"
echo "INIT-SMOKE: /init response: $(cat "$WORK/node-deps-init.json")"

CODE=$(post_tool ms_value "$WORK/node-deps-tool.json")
BODY=$(cat "$WORK/node-deps-tool.json")
case "$CODE:$BODY" in
  200:*'"content":"7200000"'*'"isError":false'*) ;;
  *)
    echo "INIT-SMOKE FAIL: the ES-module script did not import its declared dependency (HTTP $CODE)"
    echo "  response: $BODY"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
    ;;
esac

LINK_TARGET=$(docker exec "$RUNNER_NAME" readlink /mnt/agent/node_modules || true)
case "$LINK_TARGET" in
  /tmp/skrun-deps/*/node_modules) ;;
  *)
    echo "INIT-SMOKE FAIL: /mnt/agent/node_modules is not a link into the install (readlink: '$LINK_TARGET')"
    docker exec "$RUNNER_NAME" ls -la /mnt/agent 2>&1 | tail -20
    exit 1
    ;;
esac
DEPS_MS=$(deps_ms_of "$WORK/node-deps-init.json")
[ -n "$DEPS_MS" ] && [ "$DEPS_MS" -gt 0 ] || {
  echo "INIT-SMOKE FAIL: /init did not report the time spent installing (deps_ms: '${DEPS_MS}')"
  exit 1
}
echo "INIT-SMOKE: case 6 PASS — ms 2.1.3 installed at /init in ${DEPS_MS} ms, imported by an ES-module script through /mnt/agent/node_modules -> $LINK_TARGET"

# ---------------------------------------------------------------------------
# Case 7 — an install that prints the bundle's presigned URL: the failure line
# carries none of it, not even where the length limit cuts through the URL
# ---------------------------------------------------------------------------
start_runner node-fail "$INSTALL_REGISTRIES"
init_deps_bundle node-fail ms_value "$WORK/node-fail-init.json" "$PRESIGNED_URL"
CODE=$(post_tool ms_value "$WORK/node-fail-tool.json")
BODY=$(cat "$WORK/node-fail-tool.json")
case "$CODE:$BODY" in
  200:*'"content":"[SCRIPT_DEPS_INSTALL_FAILED] '*'"isError":true'*) ;;
  *)
    echo "INIT-SMOKE FAIL: the tool call did not return the typed install failure (HTTP $CODE)"
    echo "  response: $BODY"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
    ;;
esac
FAILURE_LINE=$(docker logs "$RUNNER_NAME" 2>&1 | grep 'deps_install_failed' || true)
case "$FAILURE_LINE" in
  *'"ecosystem":"node"'*'"stderr_tail":"'*'[redacted]'*) ;;
  *)
    echo "INIT-SMOKE FAIL: no deps_install_failed line with the installer's output and a blanked value"
    echo "  log line: $FAILURE_LINE"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
    ;;
esac

# Not one run of 12 characters of the URL anywhere in the line: neither the URL
# whole, nor the end of it that the length limit leaves when it cuts through it
# (that end is the signature).
i=0
while [ $((i + 12)) -le "$URL_LEN" ]; do
  case "$FAILURE_LINE" in
    *"${PRESIGNED_URL:i:12}"*)
      echo "INIT-SMOKE FAIL: the failure line carries part of the bundle's URL — characters $i to $((i + 11)) of $URL_LEN: '${PRESIGNED_URL:i:12}'"
      echo "  log line: $FAILURE_LINE"
      exit 1
      ;;
  esac
  i=$((i + 1))
done

# And the case tested what it says it does. Rebuilt from the line, each marker
# back to the URL, the installer's output cut at the limit BEFORE any blanking
# starts inside the first URL, at least 12 characters before its end. Computed
# here rather than assumed, since the length of npm's own lines is an estimate.
CUT=$(printf '%s' "$FAILURE_LINE" | docker exec -i "$RUNNER_NAME" node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const url = process.argv[1];
    const limit = Number(process.argv[2]);
    const tail = JSON.parse(input.slice(input.indexOf("{"))).stderr_tail;
    const parts = tail.split("[redacted]");
    const raw = parts.join(url);
    const kept = raw.indexOf(url) + url.length - (raw.length - limit);
    process.stdout.write(`${tail.startsWith("a") ? "lead" : "other"} ${parts.length - 1} ${kept}`);
  });
' "$PRESIGNED_URL" "$TAIL_CHARS" || true)
read -r CUT_START CUT_MARKERS CUT_KEPT <<< "$CUT"
[ "$CUT_START" = "lead" ] && [ "$CUT_MARKERS" = "2" ] \
  && [ "$CUT_KEPT" -ge 12 ] && [ "$CUT_KEPT" -lt "$URL_LEN" ] || {
  echo "INIT-SMOKE FAIL: the case no longer cuts through the URL (kept end starts in: '$CUT_START', markers: '$CUT_MARKERS', URL characters a cut before blanking would keep: '$CUT_KEPT' of $URL_LEN)"
  echo "  log line: $FAILURE_LINE"
  exit 1
}
echo "INIT-SMOKE: tool result: $BODY"
echo "INIT-SMOKE: log line, filler shortened: $(printf '%s' "$FAILURE_LINE" | sed -E 's/aaaaaaaa+/aaaa.../; s/zzzzzzzz+/zzzz.../')"
echo "INIT-SMOKE: case 7 PASS — the installer printed the bundle's URL twice; cut before blanking, the line would have kept its last $CUT_KEPT characters; it carries none, and both prints are blanked"

# ---------------------------------------------------------------------------
# Case 8 — the files a run leaves: listed within the limits the list is sent,
# what is left out counted, each file served within the size limit
# ---------------------------------------------------------------------------
start_runner outputs
CODE=$(post_init "$(init_body "$BUNDLE_SHA256")" "$WORK/outputs-init.json")
[ "$CODE" = "200" ] || {
  echo "INIT-SMOKE FAIL: /init for the outputs case answered HTTP $CODE"
  echo "  response: $(cat "$WORK/outputs-init.json")"
  docker logs "$RUNNER_NAME" 2>&1 | tail -40
  exit 1
}

# Written as the runner's own user, where a run's scripts write: 28 files.
docker exec -u 1000 "$RUNNER_NAME" bash -c '
  set -e
  cd /mnt/session/outputs
  head -c 11534336 /dev/zero > big.bin
  : > empty.txt
  head -c 1024 /dev/urandom > "$(printf "ctl-\001.txt")"
  mkdir sub
  for i in $(seq 0 24); do
    name=$(printf "f-%02d.txt" "$i")
    if [ "$i" -ge 20 ]; then name="sub/$name"; fi
    head -c 1024 /dev/urandom > "$name"
  done
'

# The first 20 by path that pass the name rule and the size limit: the empty
# file and f-00.txt to f-18.txt. f-19.txt and the five in sub/ come after the
# twentieth; big.bin is too large, wherever it falls in the order.
KEPT_AT_DEFAULTS='["empty.txt"'
for i in $(seq 0 18); do KEPT_AT_DEFAULTS="$KEPT_AT_DEFAULTS,\"$(printf 'f-%02d.txt' "$i")\""; done
KEPT_AT_DEFAULTS="$KEPT_AT_DEFAULTS]"
EXCLUDED_AT_DEFAULTS='{"name_refused":1,"too_large":1,"over_count":6}'
EXPECTED_AT_DEFAULTS="$KEPT_AT_DEFAULTS $EXCLUDED_AT_DEFAULTS"

# collect_case <label> <body, empty for none> <expected summary>
collect_case() {
  local code summary
  : > "$WORK/outputs-collect.json"
  code=$(post_collect "$2" "$WORK/outputs-collect.json") || code="$code (curl exit $?)"
  if [ "$code" != "200" ]; then
    check_fail 8 "$1: /outputs/collect answered HTTP $code ($(head -c 300 "$WORK/outputs-collect.json"))"
    return
  fi
  summary=$(collect_summary "$WORK/outputs-collect.json")
  [ "$summary" = "$3" ] || check_fail 8 "$1: listed $summary — expected $3"
}

# expect_file_status <label> <path> <status>
expect_file_status() {
  local code
  code=$(get_output "$2" "$WORK/outputs-file.bin")
  [ "$code" = "$3" ] || check_fail 8 "$1: GET /outputs/file?path=$2 answered HTTP $code, expected $3 ($(stat -c%s "$WORK/outputs-file.bin") bytes served)"
}

collect_case "limits of 20 files and 10 MiB" '{"max_size_bytes":10485760,"max_count":20}' \
  "$EXPECTED_AT_DEFAULTS"

# Limits other than the defaults: a runner that answered every list with the
# defaults would pass the call above. 1000 bytes leaves only the empty file.
collect_case "limits of 3 files and 1000 bytes" '{"max_size_bytes":1000,"max_count":3}' \
  '["empty.txt"] {"name_refused":1,"too_large":26,"over_count":0}'
# And a file is served within the size limit of the last list, not the default.
expect_file_status "after a list limited to 1000 bytes" f-00.txt 413

# Limits it cannot accept: refused, and the limits of the last list unchanged.
for body in '{"max_size_bytes":-1}' '{"max_count":null}' '{"max_size_bytes":1e18}' \
  '{"max_count":2.5}' 'not json'; do
  CODE=$(post_collect "$body" "$WORK/outputs-refused.json") || CODE="$CODE (curl exit $?)"
  [ "$CODE" = "400" ] || check_fail 8 "limits $body: /outputs/collect answered HTTP $CODE, expected 400"
done
expect_file_status "after refused limits" f-00.txt 413

# No body: the defaults, not the limits of the last list.
collect_case "no body" "" "$EXPECTED_AT_DEFAULTS"

# A file that grew after it was listed: served as the bytes it was listed at,
# its first 1024, and not one more.
docker exec -u 1000 "$RUNNER_NAME" bash -c 'head -c 1024 /dev/urandom >> /mnt/session/outputs/f-00.txt'
LISTED_SHA=$(docker exec "$RUNNER_NAME" head -c 1024 /mnt/session/outputs/f-00.txt | sha256sum | cut -d' ' -f1)
CODE=$(get_output f-00.txt "$WORK/outputs-grown.bin")
SERVED=$(stat -c%s "$WORK/outputs-grown.bin")
LENGTH=$(content_length_of "$WORK/outputs-grown.bin")
SERVED_SHA=$(sha256sum < "$WORK/outputs-grown.bin" | cut -d' ' -f1)
if [ "$CODE:$SERVED:$LENGTH" != "200:1024:1024" ]; then
  check_fail 8 "a file listed at 1024 bytes that grew to 2048: HTTP $CODE, $SERVED bytes served, Content-Length '$LENGTH' — expected 200, 1024, 1024"
elif [ "$SERVED_SHA" != "$LISTED_SHA" ]; then
  check_fail 8 "a file listed at 1024 bytes that grew to 2048: the 1024 bytes served are not its first 1024"
fi

# Whether the runner still answers, a second after it served something. A
# stream handed to the server the wrong way is served whole, then — always for
# an empty file, now and then for another — brings the whole process down: the
# failure comes after the answer, never in it, and the next request finds no
# runner. Once it is gone, the checks after it are skipped.
# still_up_after <what was served>
RUNNER_UP=1
still_up_after() {
  sleep 1
  curl -fsS "http://localhost:$RUNNER_PORT/healthz" >/dev/null 2>&1 && return 0
  RUNNER_UP=0
  check_fail 8 "the runner no longer answers after serving $1 ($(docker inspect -f '{{.State.Status}}, exit code {{.State.ExitCode}}' "$RUNNER_NAME" 2>&1)); the checks after it are skipped"
  return 1
}

# Every file of the last list, pulled one after the other as the harness pulls
# them: each served whole at the size it was listed at, the empty one as
# nothing. Twenty files served, so that a runner that falls over now and then
# after a file is seen to.
for path in $(printf '%s' "$KEPT_AT_DEFAULTS" | tr -d '[]"' | tr ',' ' '); do
  if [ "$path" = empty.txt ]; then size=0; else size=1024; fi
  CODE=$(get_output "$path" "$WORK/outputs-pull.bin")
  SERVED=$(stat -c%s "$WORK/outputs-pull.bin")
  LENGTH=$(content_length_of "$WORK/outputs-pull.bin")
  [ "$CODE:$SERVED:$LENGTH" = "200:$size:$size" ] || {
    check_fail 8 "pulling $path, listed at $size bytes: HTTP $CODE, $SERVED bytes served, Content-Length '$LENGTH'; the pulls after it are skipped"
    break
  }
done
still_up_after "the files of the list" || true

# A file of 1 MiB, within the limit and many read chunks long, written after
# the last list: served whole.
if [ "$RUNNER_UP" = 1 ]; then
  docker exec -u 1000 "$RUNNER_NAME" bash -c 'head -c 1048576 /dev/urandom > /mnt/session/outputs/large.bin'
  ON_DISK_SHA=$(docker exec "$RUNNER_NAME" sha256sum /mnt/session/outputs/large.bin | cut -d' ' -f1)
  CODE=$(get_output large.bin "$WORK/outputs-large.bin")
  SERVED=$(stat -c%s "$WORK/outputs-large.bin")
  LENGTH=$(content_length_of "$WORK/outputs-large.bin")
  SERVED_SHA=$(sha256sum < "$WORK/outputs-large.bin" | cut -d' ' -f1)
  if [ "$CODE:$SERVED:$LENGTH" != "200:1048576:1048576" ]; then
    check_fail 8 "a 1 MiB file: HTTP $CODE, $SERVED bytes served, Content-Length '$LENGTH' — expected 200, 1048576, 1048576"
  elif [ "$SERVED_SHA" != "$ON_DISK_SHA" ]; then
    check_fail 8 "a 1 MiB file: the bytes served are not the file's"
  fi
  still_up_after "a 1 MiB file" || true
fi

# A file past the size limit: not served.
if [ "$RUNNER_UP" = 1 ]; then
  expect_file_status "the 11 MiB file" big.bin 413
fi

# A file that shrinks while it is served: its Content-Length is sent before it
# is read, and the answer ends short of it. The runner must fail that answer,
# which closes the connection at once; ended cleanly, it would leave the
# connection open, and the server pulling the file waiting for bytes that never
# come — until the runner's HTTP server closes the connection as idle, about
# five seconds later. A reader inside the sandbox takes the first bytes of a
# 10 MiB file, pauses, cuts the file to nothing, and reads on half a second
# later: it reports whether the answer ended whole, was cut, or was still open
# 20 s after the file was cut, the bytes it took against the Content-Length, and
# how long after the file was cut the answer ended — within 3 s, or the runner
# did not close the connection itself. An answer served whole means the runner
# had read the file before it was cut — the case did not happen, and that fails
# too.
if [ "$RUNNER_UP" = 1 ]; then
  docker exec -u 1000 "$RUNNER_NAME" bash -c 'head -c 10485760 /dev/urandom > /mnt/session/outputs/shrinks.bin'
  SHRINK=$(docker exec "$RUNNER_NAME" node -e '
    const http = require("node:http");
    const fs = require("node:fs");
    let got = 0;
    let length = -1;
    let cutAt = 0;
    const report = (outcome) => {
      const ms = cutAt === 0 ? -1 : Date.now() - cutAt;
      process.stdout.write(`${outcome} ${got} ${length} ${ms}`);
      process.exit(0);
    };
    setTimeout(() => report("unanswered"), 30000);
    const request = http.get("http://127.0.0.1:9000/outputs/file?path=shrinks.bin", (res) => {
      length = Number(res.headers["content-length"] ?? -1);
      res.on("data", (chunk) => {
        got += chunk.length;
      });
      res.once("data", () => {
        res.pause();
        fs.truncateSync("/mnt/session/outputs/shrinks.bin", 0);
        cutAt = Date.now();
        setTimeout(() => report("open"), 20000);
        setTimeout(() => res.resume(), 500);
      });
      res.on("error", () => {});
      res.on("close", () => report(res.complete ? "whole" : "cut"));
    });
    request.on("error", () => report("cut"));
  ' 2>&1)
  read -r SHRINK_OUTCOME SHRINK_GOT SHRINK_LENGTH SHRINK_MS <<< "$SHRINK"
  case "$SHRINK_OUTCOME" in
    cut)
      if [ "$SHRINK_LENGTH" != 10485760 ] || [ "$SHRINK_GOT" -ge "$SHRINK_LENGTH" ]; then
        check_fail 8 "a file that shrank while it was served: cut after $SHRINK_GOT bytes of a Content-Length of '$SHRINK_LENGTH' — expected fewer bytes than 10485760"
      elif [ "$SHRINK_MS" -lt 0 ] || [ "$SHRINK_MS" -gt 3000 ]; then
        check_fail 8 "a file that shrank while it was served: the answer was cut $SHRINK_MS ms after the file was — expected within 3 s (the reader reads on after 0.5 s); later is the HTTP server closing an idle connection, not the runner failing the answer"
      else
        echo "INIT-SMOKE: a file that shrank while it was served: cut after $SHRINK_GOT of $SHRINK_LENGTH bytes, $SHRINK_MS ms after the file was (the reader read on after 500 ms)"
      fi
      ;;
    open)
      check_fail 8 "a file that shrank while it was served: the answer was still open 20 s after the file was cut, $SHRINK_GOT of $SHRINK_LENGTH bytes taken — the runner ended it short without closing the connection"
      ;;
    whole)
      check_fail 8 "a file that shrank while it was served: served whole ($SHRINK_GOT of $SHRINK_LENGTH bytes) — the runner had read it before it was cut, so the case did not happen"
      ;;
    *)
      check_fail 8 "a file that shrank while it was served: the reader reported '$SHRINK'"
      ;;
  esac
  still_up_after "a file that shrank while it was served" || true
fi

if [ "$CHECK_FAILURES" -eq 0 ]; then
  echo "INIT-SMOKE: case 8 PASS — 28 files: 20 kept at 10 MiB and 20 files, the large one, the refused name and the six past the twentieth counted; other limits applied, the defaults for no body, five unacceptable limits refused; served within the last list's limit — a grown file as listed, the 20 of the list each at its size, the empty one as nothing, 1 MiB whole, the runner up after each, and a larger one refused; a file that shrank while it was served cut at once, the runner still up"
fi

# ---------------------------------------------------------------------------
# Case 9 — tool results far past the bound on an answer: cut to fit, with the
# marker the model reads, on a result and on an error alike
# ---------------------------------------------------------------------------
CASE_9_FAILURES_BEFORE=$CHECK_FAILURES
start_runner big-results
BIG_RESULTS_SHA256="$(sha256sum "$WORK/serve/big-results.agent" | cut -d' ' -f1)"
TOOL_FIELDS='"description":"init smoke","input_schema":{"type":"object","properties":{},"additionalProperties":true}'
CODE=$(post_init "$(printf '{"bundleUrl":"http://%s:8000/big-results.agent","tools":[{"name":"big_result",%s},{"name":"big_error",%s}],"mcpServers":[],"allowedHosts":[],"bundleSha256":"%s"}' \
  "$FIXTURE_HOST" "$TOOL_FIELDS" "$TOOL_FIELDS" "$BIG_RESULTS_SHA256")" "$WORK/big-results-init.json")
[ "$CODE" = "200" ] || {
  echo "INIT-SMOKE FAIL: /init with the large results bundle answered HTTP $CODE"
  echo "  response: $(cat "$WORK/big-results-init.json")"
  docker logs "$RUNNER_NAME" 2>&1 | tail -40
  exit 1
}

# tool_answer_case <tool> <isError expected> <how its content begins>
tool_answer_case() {
  local code verdict
  : > "$WORK/$1.json"
  code=$(post_tool "$1" "$WORK/$1.json") || code="$code (curl exit $?)"
  # Read by the runner's own node, against the bound and the marker of the
  # runtime it ships. Prints "ok <bytes>", or what is wrong.
  verdict=$(docker exec -i "$RUNNER_NAME" node --input-type=module -e '
    const rules = await import(process.argv[1]);
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      console.log(`not valid JSON (${raw.length} bytes)`);
      process.exit(0);
    }
    const max = rules.TOOL_RESPONSE_MAX_BYTES;
    const problems = [];
    if (raw.length > max) problems.push(`${raw.length} bytes, past the bound of ${max}`);
    else if (raw.length < max - 1024) problems.push(`${raw.length} bytes, cut far shorter than the bound of ${max}`);
    if (typeof body.content !== "string") problems.push("no text content");
    else {
      if (!body.content.startsWith(process.argv[3])) problems.push("its content does not begin as the tool wrote it");
      if (!body.content.endsWith(rules.TOOL_RESULT_TRUNCATION_MARKER)) problems.push("no truncation marker at its end");
    }
    if (body.isError !== (process.argv[2] === "true")) problems.push(`isError is ${body.isError}`);
    console.log(problems.length > 0 ? problems.join("; ") : `ok ${raw.length}`);
  ' "$OUTPUT_RULES_MODULE" "$2" "$3" < "$WORK/$1.json")
  case "$code:$verdict" in
    "200:ok "*) echo "INIT-SMOKE: $1 answered $(printf '%s' "$verdict" | cut -d' ' -f2) bytes, the marker at its end" ;;
    *) check_fail 9 "$1 (HTTP $code): $verdict" ;;
  esac
}

tool_answer_case big_result false rrrrrrrrrr
tool_answer_case big_error true Traceback

if [ "$CHECK_FAILURES" -eq "$CASE_9_FAILURES_BEFORE" ]; then
  echo "INIT-SMOKE: case 9 PASS — a 3 MiB result and a 3 MiB error each answered within the bound, as valid JSON, with the marker at the end"
fi

[ "$CHECK_FAILURES" -eq 0 ] || {
  echo "INIT-SMOKE FAIL: $CHECK_FAILURES check(s) of cases 8 and 9 failed"
  exit 1
}

# ---------------------------------------------------------------------------
# Case 10 — a bundle whose server cuts the connection in the middle of the
# body: /init fails at that step, and the runner is still there
# ---------------------------------------------------------------------------
start_runner cut-body
CODE=$(post_init "$(printf '{"bundleUrl":"http://%s:%s/cut.agent","tools":[],"mcpServers":[],"allowedHosts":[]}' \
  "$FIXTURE_HOST" "$CUT_PORT")" "$WORK/cut-body.json")
BODY=$(cat "$WORK/cut-body.json")
[ "$CODE" = "500" ] || {
  echo "INIT-SMOKE FAIL: /init with a bundle cut in the middle of its body answered HTTP $CODE — expected 500"
  echo "  response: $BODY"
  docker logs "$RUNNER_NAME" 2>&1 | tail -40
  exit 1
}
case "$BODY" in
  *'"stage":"bundle-incomplete"'*) ;;
  *)
    echo "INIT-SMOKE FAIL: /init failed on a cut bundle without naming the incomplete download as its step"
    echo "  response: $BODY"
    exit 1
    ;;
esac
# The process the cut used to bring down is still answering.
curl -fsS "http://localhost:$RUNNER_PORT/healthz" >/dev/null || {
  echo "INIT-SMOKE FAIL: the runner stopped answering after a bundle download was cut"
  docker logs "$RUNNER_NAME" 2>&1 | tail -40
  exit 1
}
[ "$(docker inspect -f '{{.State.Running}}' "$RUNNER_NAME")" = "true" ] || {
  echo "INIT-SMOKE FAIL: the runner's container is no longer running after a bundle download was cut"
  docker logs "$RUNNER_NAME" 2>&1 | tail -40
  exit 1
}
# And what the cut left of the archive was removed.
docker exec "$RUNNER_NAME" sh -c 'test ! -e /tmp/skrun-bundle.tgz && test ! -e /tmp/skrun-bundle.tgz.part' || {
  echo "INIT-SMOKE FAIL: a partial bundle archive was left on the runner's disk"
  docker exec "$RUNNER_NAME" ls -la /tmp 2>&1 | tail -20
  exit 1
}
echo "INIT-SMOKE: /init on a cut bundle: $BODY"
echo "INIT-SMOKE: case 10 PASS — a bundle cut in the middle of its body failed /init at its step, the runner still answered, and no partial archive was left"

# An /init body for a bundle served as it is, with its checksum.
# bundle_body <bundle>
bundle_body() {
  printf '{"bundleUrl":"http://%s:8000/%s.agent","tools":[],"mcpServers":[],"allowedHosts":[],"bundleSha256":"%s"}' \
    "$FIXTURE_HOST" "$1" "$(sha256sum "$WORK/serve/$1.agent" | cut -d' ' -f1)"
}

# expect_init_failure <case> <response file> <code> <step> <what> — the answer is a
# 500 naming <step>, and the runner still answers.
expect_init_failure() {
  local body
  body=$(cat "$2")
  [ "$3" = "500" ] || {
    echo "INIT-SMOKE FAIL: case $1 — /init with $5 answered HTTP $3, expected 500"
    echo "  response: $body"
    docker logs "$RUNNER_NAME" 2>&1 | tail -40
    exit 1
  }
  case "$body" in
    *"\"stage\":\"$4\""*) ;;
    *)
      echo "INIT-SMOKE FAIL: case $1 — /init with $5 did not name $4 as its step"
      echo "  response: $body"
      docker logs "$RUNNER_NAME" 2>&1 | tail -40
      exit 1
      ;;
  esac
  curl -fsS "http://localhost:$RUNNER_PORT/healthz" >/dev/null || {
    echo "INIT-SMOKE FAIL: case $1 — the runner stopped answering after /init failed with $5"
    exit 1
  }
  echo "INIT-SMOKE: /init with $5: $body"
}

# ---------------------------------------------------------------------------
# Case 11 — a bundle that is not a gzip, its checksum the right one: the download
# and the checksum pass, the extraction fails — the bundle's own fault
# ---------------------------------------------------------------------------
start_runner not-gzip
CODE=$(post_init "$(bundle_body not-gzip)" "$WORK/not-gzip.json")
expect_init_failure 11 "$WORK/not-gzip.json" "$CODE" bundle-extract "a bundle that is not a gzip"
echo "INIT-SMOKE: case 11 PASS — a bundle that is not a gzip, its checksum right, failed /init at its extraction"

# ---------------------------------------------------------------------------
# Case 12 — a bundle that extracts more than its disk holds: a full disk, no
# fault of the bundle's. The bundle's directory is a small disk of its own.
# ---------------------------------------------------------------------------
start_runner disk-full "" --tmpfs "/mnt/agent:size=$DISK_FULL_TMPFS_SIZE,uid=1000,gid=1000,mode=0755"
CODE=$(post_init "$(bundle_body big-file)" "$WORK/disk-full.json")
expect_init_failure 12 "$WORK/disk-full.json" "$CODE" disk-full "a bundle larger than its disk"
echo "INIT-SMOKE: case 12 PASS — a bundle that extracts more than its $DISK_FULL_TMPFS_SIZE disk holds failed /init at a full disk, not at its extraction"

# ---------------------------------------------------------------------------
# Case 13 — a tar ended by a signal: tar said nothing of the bundle, which
# another machine may well extract. The runner's PATH finds the case's tar first.
# ---------------------------------------------------------------------------
IMAGE_PATH="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$TAG" | sed -n 's/^PATH=//p')"
[ -n "$IMAGE_PATH" ] || {
  echo "INIT-SMOKE FAIL: case 13 — could not read the image's PATH"
  exit 1
}
start_runner killed-tar "" -v "$WORK/killed-tar:/opt/skrun-smoke-tar:ro" -e "PATH=/opt/skrun-smoke-tar:$IMAGE_PATH"
CODE=$(post_init "$(init_body "$BUNDLE_SHA256")" "$WORK/killed-tar.json")
expect_init_failure 13 "$WORK/killed-tar.json" "$CODE" other "a tar ended by a signal"
grep -q 'SIGKILL' "$WORK/killed-tar.json" || {
  echo "INIT-SMOKE FAIL: case 13 — the failure does not say the signal that ended tar: $(cat "$WORK/killed-tar.json")"
  exit 1
}
echo "INIT-SMOKE: case 13 PASS — a tar ended by a signal failed /init at no step of the bundle's"

echo "INIT-SMOKE PASS: the runner fetched a bundle through its own egress allowlist, extracted it when the checksum matched, refused it before extraction when it did not, naming the checksum as the step, and reported the case where none was supplied; it installed the dependencies a bundle declares at /init, for Python and for an ES-module Node script, turned an install it could not make into a typed tool failure and a log line, and kept the bundle's presigned URL out of that line, whole or cut; it listed a run's files within the limits it was sent, counted what it left out, served each file within the size limit and no further than it was listed, failed at once the answer of a file that shrank while it was served, cut tool results to fit the bound on an answer, with the marker the model reads, failed /init at its step when a bundle's body was cut, still up, no partial archive left, and told an extraction's failure by its cause: the bundle's, a full disk, or a tar ended by a signal."
