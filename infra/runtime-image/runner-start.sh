#!/bin/bash
#
# runner-start.sh — exec'd by entrypoint.sh AFTER capsh handoff (zero caps +
# uid 1000) in runner mode. At this point the process has NO capabilities
# and runs as skrun-runner (uid 1000) per the Zero Trust posture.
#
# Responsibility: launch the in-machine RPC server (Hono on :9000 by default,
# configurable via RUNNER_PORT). The server exposes /init, /tool,
# /outputs/collect, /healthz over the Fly.io 6PN private network — never
# reachable from the public internet (no [http_service] entry in fly.toml
# for runner-mode machines).
#
# Inputs (read by the Node server, not this script):
#   BUNDLE_URL          presigned URLs an earlier harness put here; the
#   OUTPUTS_PUT_URL     current one sends them in the body of /init only.
#                       Read only to be masked in a log line.
#   SKRUN_ALLOWED_HOSTS CSV of hosts (already enforced via iptables by
#                       entrypoint.sh — this env value is also forwarded to
#                       ScriptToolProvider + McpToolProvider for in-process
#                       network gating at the SDK layer)
#   RUNNER_PORT         port to listen on (default 9000)
#
# Exit codes:
#   propagated from node — non-zero means the runner crashed and the
#   FlyioAdapter will tear down the machine + emit run_error.

set -euo pipefail

# All logs to stderr (>&2) — stdout is line-buffered and gets lost when
# the child node process crashes within ms (Fly's log forwarder doesn't
# flush in time). entrypoint.sh follows the same pattern via its log()
# helper. Surfaced 2026-05-25 during dev11 → dev12 debug cycle.
echo "[skrun-runner-start] starting in-machine RPC server (port=${RUNNER_PORT:-9000})" >&2
echo "[skrun-runner-start] node version: $(node --version 2>&1)" >&2
echo "[skrun-runner-start] uid=$(id -u) gid=$(id -g)" >&2

# One home for the runner and everything it starts, under /tmp with the rest of
# this run's scratch (the bundle archive, the dependency cache). Left alone,
# HOME is whatever the capsh handoff derives from the user database — the
# user's home directory in the image — so it would depend on the capsh version
# and on how the image creates that user; set here, it depends on neither. npm
# keeps its cache under HOME (npx too, which starts stdio MCP servers), and pip
# its own. The agent's scripts receive HOME through their allowlist, the
# dependency installers through their environment, stdio MCP servers through
# the MCP SDK's default environment — one setting for all of them, none per
# tool. /tmp is writable on a runner machine, and a machine serves a single run.
# Created here, by this user, and refused if anything else holds the name.
runner_home=/tmp/skrun-home
mkdir -p -m 0700 "$runner_home"
if [ -L "$runner_home" ] || [ ! -d "$runner_home" ] || [ ! -O "$runner_home" ]; then
  echo "[skrun-runner-start] FATAL: $runner_home is not a directory owned by uid $(id -u)" >&2
  exit 1
fi
chmod 0700 "$runner_home"
export HOME="$runner_home"
# No compiler in this image: when a package has an older version with a
# prebuilt wheel, take it over a source build that cannot succeed here.
export PIP_PREFER_BINARY=1
echo "[skrun-runner-start] HOME=$HOME" >&2
echo "[skrun-runner-start] /opt/skrun-runner/dist contents:" >&2
ls -la /opt/skrun-runner/dist/ >&2 || echo "  (ls failed)" >&2
echo "[skrun-runner-start] node_modules/@skrun-dev contents:" >&2
ls -la /opt/skrun-runner/node_modules/@skrun-dev/ >&2 || echo "  (no @skrun-dev/)" >&2
echo "[skrun-runner-start] exec'ing node /opt/skrun-runner/dist/index.js" >&2
exec node /opt/skrun-runner/dist/index.js
