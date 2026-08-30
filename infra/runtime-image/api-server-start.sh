#!/bin/bash
#
# api-server-start.sh — exec'd by entrypoint.sh in api-server mode.
#
# Unlike runner-start.sh, no iptables setup, no capsh handoff: the
# harness operates AT the trust boundary (it holds DB + LLM + Fly.io +
# R2 credentials, by design). The runner mode is the
# credential-free sandbox; THIS mode is intentionally privileged.
#
# Listens on PORT (default 4000). Requires (at minimum) DATABASE_URL +
# S3_* + WEBHOOK_SIGNING_KEY + at least one LLM API key
# env. See `packages/api/src/server.ts` for the full required env list
# — the api-server itself emits a fail-loud `process.exit(1)` if any
# required var is missing.
#
# Inputs (read by the Node server, not this script):
#   PORT                  Listen port (default 4000)
#   DATABASE_URL          Standard postgres:// connection string (any Postgres >= 14)
#   S3_*                  R2 / MinIO config (presigned URLs for spawned runners)
#   SKRUN_RUNTIME         "local" (default) or "flyio" for cloud sandbox spawn
#   FLY_API_TOKEN+        Required when SKRUN_RUNTIME=flyio
#   FLY_APP_NAME
#   LLM provider keys     ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / ...
#   WEBHOOK_SIGNING_KEY   HMAC key for async webhook delivery
#   CORS_ORIGIN           Required when NODE_ENV=production
#   SKRUN_DASHBOARD       "on" (default) | "off" — serve the operator dashboard
#                         at /dashboard (off/false/0 disables it)
#   SKRUN_DASHBOARD_DIR   dashboard SPA dir (image default: /opt/skrun-web/dist)
#
# Exit codes:
#   propagated from node — non-zero means startup or runtime crash.

set -euo pipefail

echo "[skrun-api-start] starting api-server (port=${PORT:-4000})"
exec node /opt/skrun-api/node_modules/@skrun-dev/api/dist/server.js
