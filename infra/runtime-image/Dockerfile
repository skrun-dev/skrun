# syntax=docker/dockerfile:1.7
#
# skrun-runtime — multi-runtime agent sandbox image (multi-target).
#
# ONE Dockerfile, a shared `base` stage + two build targets:
#   - runner     (--target runner)      : SLIM cloud sandbox. In-machine RPC
#                 server for ScriptToolProvider + McpToolProvider. NO api-server
#                 bundle, NO dashboard, NO build-essential. Pulled by the cloud
#                 from a co-located registry for faster cold starts. Credentials
#                 never enter this mode.
#   - api-server (--target api-server)  : FULL self-host single-tenant. The base
#                 PLUS build-essential (self-host compiles agent-script native
#                 deps at runtime via the LocalAdapter/ScriptToolProvider path) +
#                 the Hono API + LocalAdapter + operator dashboard. Self-host
#                 default (:edge / :latest / :vX.Y.Z). A strict SUPERSET of runner.
#
# The two targets share the `base` stage — BuildKit builds it ONCE. Both dispatch
# runner vs api-server at runtime via SKRUN_CONTAINER_MODE (pinned per target).
#
# Aligned with CMA agent_toolset_20260401 so Skills that run on Claude Managed
# Agents also run on Skrun. Tools baked: git, curl, jq, ripgrep, vim. Runtimes:
# Python 3.12, OpenJDK 21, PHP 8.3 (apt) + Node 22, Go 1.22, Rust 1.77, Ruby 3.3
# (mise — see .mise.toml).
#
# Zero Trust hardening (both targets): runs as uid 1000 (skrun-runner), no new
# privileges, read-only rootfs except /mnt/session/outputs tmpfs (set in compose).
# cap-drop is handled by the entrypoint via capsh handoff after iptables setup.
#
# Build (docker buildx bake — see docker-bake.hcl):
#   pnpm --filter @skrun-dev/schema  pack -o infra/runtime-image/
#   pnpm --filter @skrun-dev/runtime pack -o infra/runtime-image/
#   pnpm --filter @skrun-dev/api     pack -o infra/runtime-image/
#   docker buildx bake -f infra/runtime-image/docker-bake.hcl
# Or a single target directly:
#   docker build --target runner     -t skrun-runtime:runner     infra/runtime-image/
#   docker build --target api-server -t skrun-runtime:api-server infra/runtime-image/

# ============================ shared base ============================
# Digest-pinned: a tag is mutable, so `ubuntu:24.04` can
# resolve to a different image between two builds of the same commit. Both
# targets below derive from this stage, so pinning it once covers the whole file.
# Refresh with: docker buildx imagetools inspect ubuntu:24.04
FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517 AS base

# ---------- System layer (apt) ----------
#
# Tini as PID 1 — reaps zombie subprocesses spawned by scripts + MCP.
# Python 3.12 / OpenJDK 21 / PHP 8.3 are noble defaults (24.04).
# iptables + dnsutils + libcap2-bin are for entrypoint's Zero Trust setup
# (iptables egress allowlist + capsh handoff).
#
# NOTE: `build-essential` is intentionally NOT installed here — it is only needed
# by the `api-server` target (self-host compiles native deps for some agent Python
# packages — pandas/numpy/etc. — at RUNTIME via the LocalAdapter + depsCache). The
# runner never installs agent deps (ScriptToolProvider runs with no depsCache in
# runner mode), and its own npm install below is pure-JS (Hono + MCP SDK) → no C
# compiler needed. Keeping build-essential out of the base is the bulk of the
# runner slim-down.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      ca-certificates \
      tini \
      git \
      curl \
      jq \
      ripgrep \
      vim \
      python3.12 \
      python3-pip \
      python3.12-venv \
      openjdk-21-jre-headless \
      php-cli \
      ruby-full \
      iptables \
      dnsutils \
      libcap2-bin \
    && rm -rf /var/lib/apt/lists/*

# Symlink python3 → python (Skill compat: many scripts shebang `python`).
RUN ln -sf /usr/bin/python3.12 /usr/local/bin/python

# ---------- mise layer (Node/Go/Rust pinned via .mise.toml) ----------
# Ruby is intentionally NOT managed by mise — see the comment in `.mise.toml`.
# Ubuntu 24.04's apt `ruby-full` is good enough and rock-solid.
ENV MISE_DATA_DIR=/opt/mise
ENV MISE_CONFIG_DIR=/etc/mise
ENV PATH=/opt/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Was `curl https://mise.run | sh` — an unpinned remote
# script piped into a shell, poisoning the base layer BOTH targets share if
# mise.run or the build network is ever compromised. The installer is gone
# entirely: we fetch the pinned release binary and verify its digest before it
# is ever made executable.
#
# ⚠️ PER-ARCHITECTURE, and that is not optional. This image is multi-arch
# (linux/amd64 + linux/arm64 — without arm64,
# Mac M-series self-host and Fly arm-region machines break). The installer we
# removed detected the architecture itself; a hardcoded `linux-x64` URL passed
# its checksum on arm64 — it IS the genuine x64 file — and then died with
# `exec format error`. `mise --version` below is what caught it, and it stays
# for that reason.
#
# `TARGETARCH` is supplied by buildx per platform (amd64 / arm64).
#
# To bump: pick a tag from https://github.com/jdx/mise/releases and take BOTH
# the `mise-<tag>-linux-x64` and `mise-<tag>-linux-arm64` lines from that
# release's SHASUMS256.txt.
ARG TARGETARCH
ARG MISE_VERSION=v2026.8.12
ARG MISE_SHA256_AMD64=f2092b1e67f0abc8803d3be120dd2bc5b656dd99680ba3159f710e149da10d05
ARG MISE_SHA256_ARM64=071e2d16905360fa04762422a2a889692bb3a4d30f27650de50bc1ac0564840b
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) asset="linux-x64";   sha="${MISE_SHA256_AMD64}" ;; \
      arm64) asset="linux-arm64"; sha="${MISE_SHA256_ARM64}" ;; \
      *) echo "no pinned mise checksum for TARGETARCH='${TARGETARCH}'" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/mise \
      "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-${asset}"; \
    echo "${sha}  /tmp/mise" | sha256sum -c -; \
    install -m 0755 /tmp/mise /usr/local/bin/mise; \
    rm -f /tmp/mise; \
    mise --version

COPY .mise.toml /etc/mise/config.toml

RUN mise trust /etc/mise/config.toml \
    && mise install \
    && mise reshim

# ---------- Non-root user ----------
# uid 1000 enforced by the Zero Trust controls. Ubuntu 24.04 ships a pre-existing
# `ubuntu` user at uid/gid 1000 — remove it first so we can claim that uid for
# skrun-runner (the spec pins uid 1000; the production compose sets user '1000:1000').
RUN userdel -r ubuntu 2>/dev/null || true \
    && groupadd -g 1000 skrun-runner \
    && useradd -m -u 1000 -g 1000 -s /bin/bash skrun-runner \
    && mkdir -p /mnt/agent /mnt/session/outputs \
    && chown -R skrun-runner:skrun-runner /mnt/agent /mnt/session/outputs

WORKDIR /mnt/agent

# ---------- Runner (standalone Node app) ----------
#
# The runner is a STANDALONE Node package (not a pnpm workspace member) to avoid
# leaking its lockfile into the public OSS repo via `pnpm-lock.yaml`. Its sole
# dependency on `@skrun-dev/runtime` is injected at build time as RUNTIME_TGZ.
#
# `pnpm pack` REWRITES `@skrun-dev/schema: workspace:*` to a concrete published
# version, so `npm install <runtime tgz>` resolves @skrun-dev/schema from the
# public npm registry — NO schema tarball is needed for the runner. The runner's
# deps (Hono + MCP SDK) are pure-JS → no build-essential needed for this install.
#
# Build uses `npm` (not pnpm): the runner has no workspace links. `npm run build`
# runs tsc (devDeps must be present — hence NODE_ENV is set per-target LATER, not
# here, so this install keeps devDependencies).
ARG RUNTIME_TGZ=skrun-dev-runtime.tgz

COPY runner/ /opt/skrun-runner/
COPY ${RUNTIME_TGZ} /opt/skrun-runner/${RUNTIME_TGZ}

RUN cd /opt/skrun-runner \
    && npm install --no-audit --no-fund \
    && npm install --no-audit --no-fund /opt/skrun-runner/${RUNTIME_TGZ} \
    && npm run build \
    && rm -f /opt/skrun-runner/${RUNTIME_TGZ}
# NOTE — `npm prune --omit=dev` removed 2026-05-25 (Unit 2/3 H1 fix). Suspected of
# stripping a transitive prod dep of @skrun-dev/runtime whose absence crashed the
# runner at module-load. The ~50MB saving wasn't worth the foot-gun.

# ---------- Entrypoint (shared by both targets) ----------
# Dispatcher between `runner` (cloud sandbox) and `api-server` (self-host) modes,
# selected by SKRUN_CONTAINER_MODE (pinned per target below). Runner mode
# configures iptables egress from SKRUN_ALLOWED_HOSTS, spawns the DNS re-resolve
# loop, then hands off to runner-start.sh via capsh (drop all caps + uid 1000).
COPY --chmod=0755 net-lib.sh /usr/local/bin/net-lib.sh
COPY --chmod=0755 entrypoint.sh /entrypoint.sh
COPY --chmod=0755 dns-reresolve.sh /usr/local/bin/dns-reresolve.sh
COPY --chmod=0755 runner-start.sh /usr/local/bin/runner-start.sh
COPY --chmod=0755 api-server-start.sh /usr/local/bin/api-server-start.sh

# Entrypoint runs as root to set up iptables (NET_ADMIN granted at runtime via
# docker-compose `cap_add`), then `capsh --user=skrun-runner` drops all caps +
# switches uid before exec'ing the runner or api-server.
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

# ============================ runner target (cloud) ============================
# Slim: the base ONLY. No /opt/skrun-api, no /opt/skrun-web, no build-essential.
FROM base AS runner

# Cloud sandbox mode — pinned so a `runner` image never tries to launch the
# absent api-server/dashboard (clean failure over a confusing one).
ENV SKRUN_CONTAINER_MODE=runner

# Production by default (harmless for runner mode; keeps parity with api-server).
# Set AFTER the base's runner npm install so devDependencies were installed for tsc.
ENV NODE_ENV=production

# ======================= api-server target (self-host default) =======================
# Full: the base PLUS build-essential + the Hono API bundle + the operator
# dashboard. A strict SUPERSET of `runner` (still contains /opt/skrun-runner).
FROM base AS api-server

# build-essential — native deps for some agent Python packages (pandas/numpy/etc.)
# installed at RUNTIME by the api-server / LocalAdapter path (ScriptToolProvider +
# depsCache). The cloud runner never hits this path, so it stays out of that image.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

# ---------- API server bundle (api-server mode) ----------
#
# Three tarballs installed as siblings under /opt/skrun-api/node_modules/, in
# dependency order (schema → runtime → api) so npm resolves each `workspace:*` ref
# to the corresponding tarball at install time. The api package ships its prod
# deps (Hono, pg, AWS SDK, etc.) via the standard npm registry.
ARG SCHEMA_TGZ=skrun-dev-schema.tgz
ARG RUNTIME_TGZ=skrun-dev-runtime.tgz
ARG API_TGZ=skrun-dev-api.tgz

RUN mkdir -p /opt/skrun-api
COPY ${SCHEMA_TGZ} /opt/skrun-api/${SCHEMA_TGZ}
COPY ${RUNTIME_TGZ} /opt/skrun-api/${RUNTIME_TGZ}
COPY ${API_TGZ} /opt/skrun-api/${API_TGZ}

RUN cd /opt/skrun-api \
    && npm init -y >/dev/null \
    && npm install --no-audit --no-fund \
        ./${SCHEMA_TGZ} ./${RUNTIME_TGZ} ./${API_TGZ} \
    && rm -f /opt/skrun-api/*.tgz

# ---------- Dashboard (operator web SPA — api-server mode) ----------
# The operator dashboard (packages/web, a Vite SPA) is served by api-server mode
# at /dashboard/*. Its built static files are staged into the build context as
# web-dist/ by the runtime-image workflow. SKRUN_DASHBOARD_DIR points the
# api-server at it; set SKRUN_DASHBOARD=off for a headless API deployment.
COPY web-dist/ /opt/skrun-web/dist/
ENV SKRUN_DASHBOARD_DIR=/opt/skrun-web/dist

# Self-host default mode.
ENV SKRUN_CONTAINER_MODE=api-server

# Production by default so the dev-auth fail-secure interlock holds even on a bare
# `docker run` (no compose / Fly env). See packages/api/src/index.ts. Set AFTER the
# npm installs above so they kept devDependencies (parity with the pre-split image).
ENV NODE_ENV=production
