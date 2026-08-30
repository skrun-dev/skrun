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
#   BUNDLE_URL          presigned R2 GET URL — bundle is downloaded by /init
#   OUTPUTS_PUT_URL     presigned R2 PUT URL — outputs are uploaded by
#                       /outputs/collect (forward-compat: not wired yet)
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
echo "[skrun-runner-start] /opt/skrun-runner/dist contents:" >&2
ls -la /opt/skrun-runner/dist/ >&2 || echo "  (ls failed)" >&2
echo "[skrun-runner-start] node_modules/@skrun-dev contents:" >&2
ls -la /opt/skrun-runner/node_modules/@skrun-dev/ >&2 || echo "  (no @skrun-dev/)" >&2
echo "[skrun-runner-start] exec'ing node /opt/skrun-runner/dist/index.js" >&2
exec node /opt/skrun-runner/dist/index.js
