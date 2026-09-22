#!/bin/bash
#
# api-server-start.sh — exec'd by entrypoint.sh in api-server mode.
#
# Unlike runner-start.sh, no iptables setup, no capsh handoff: the
# harness operates AT the trust boundary (it holds DB + LLM + Fly.io +
# R2 credentials, by design). The runner mode is the
# credential-free sandbox; THIS mode is intentionally privileged.
#
# Listens on PORT (default 4000).
#
# ALWAYS required — the pre-flight in `packages/api/src/server.ts`, which runs
# before anything else and exits naming what is missing:
#   DATABASE_URL, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and ONE
#   of S3_ACCOUNT_ID / S3_ENDPOINT.
#
# Required UNDER A CONDITION — nothing asks for these on a bare local run, and
# they refuse the boot as loudly as the ones above on a deployment that meets
# the condition. Refusals live in `packages/api/src/index.ts` and
# `packages/api/src/runtime/adapter-selection.ts`:
#   CORS_ORIGIN         when NODE_ENV=production. ⚠️ The shipped docker-compose.yml
#                       sets NODE_ENV=production and leaves CORS_ORIGIN empty, so
#                       once the stack's own preflight is satisfied (database
#                       password and storage keys), this is the first refusal the
#                       api process itself raises.
#   SKRUN_PUBLIC_URL    when SKRUN_SESSION_COOKIE_DOMAIN is set — the domain is
#                       validated against that canonical host, under four more
#                       rules on the pair (a literal IP, a single label, a
#                       non-suffix, a public suffix are each refused).
#   FLY_API_TOKEN,      when SKRUN_RUNTIME=flyio — the whole block is checked at
#   SKRUN_RUNNERS_APP,  once and the refusal names every one that is missing.
#   RUNTIME_IMAGE_TAG   (S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are
#                       in that block too, and already required above.)
#
# A MALFORMED value is a boot refusal too, wherever a setting is parsed at
# startup rather than at first use — among them SKRUN_VERIFICATION_POLICY (an
# unknown policy), SKRUN_SECRETS_ENCRYPTION_KEY (a key that does not decode),
# SKRUN_PUSH_MAX_BODY_MB (a non-positive number), SKRUN_RUNTIME (an unknown
# engine), DATABASE_URL (a scheme that is not postgres://). That list is the
# SHAPE of the rule, not an inventory of it: read the two files above rather
# than treating these lines as exhaustive.
#
# SKRUN_DEV_AUTH has its own lock: enabled without OAuth outside a development
# or test NODE_ENV, the server refuses to start rather than hand admin to any
# caller holding the dev token.
#
# Two inputs that look required here and are not:
#   - WEBHOOK_SIGNING_KEY is fail-closed at DELIVERY, not at startup: the
#     server boots without it and refuses to send an async webhook.
#   - No LLM provider key is needed to boot. Setting one makes it the
#     last-resort key for every caller, so on a multi-user instance it is a
#     decision about who spends it, not a prerequisite.
#
# Inputs (read by the Node server, not this script):
#   PORT                  Listen port (default 4000)
#   DATABASE_URL          Standard postgres:// connection string (any Postgres >= 14)
#   S3_*                  R2 / MinIO config (presigned URLs for spawned runners)
#   SKRUN_RUNTIME         "local" (default) or "flyio" for cloud sandbox spawn
#   FLY_API_TOKEN+        Required when SKRUN_RUNTIME=flyio
#   SKRUN_RUNNERS_APP     Also required then — the app the per-run sandboxes
#                         are created in, which is NOT the app the api-server
#                         itself runs in.
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
