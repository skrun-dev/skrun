#!/usr/bin/env bash
#
# update-locks.sh — regenerate the npm locks the image installs from.
#
# The image installs its Node dependencies with `npm ci`, one lock per block:
#   runner/package-lock.json       the runner (both targets)
#   api-server/package-lock.json   the API (api-server target only)
# Each lock must hold exactly the versions pnpm-lock.yaml resolved (the ones the
# repository's tests ran against), transitive dependencies included, with the
# same integrity hashes. tests/e2e/image-locks.test.ts fails while a lock holds a
# name@version, or an integrity, that pnpm-lock.yaml does not — membership: it
# cannot tell which path pnpm resolved a version for, which this script gets
# right by seeding the lock from pnpm's own tree.
#
# When: after any change to pnpm-lock.yaml that reaches a production dependency
# of @skrun-dev/schema, @skrun-dev/runtime or @skrun-dev/api, or a direct
# dependency of a block's package.json.
#   1. In each block's package.json, set every pinned version to the one
#      pnpm-lock.yaml resolved — the test names each one that differs.
#   2. bash infra/runtime-image/update-locks.sh
#   3. pnpm test:e2e
# An override for a transitive dependency that another package pins to an
# exact version takes the bare name as its key ("name": "^x.y.z"), in the root
# and both blocks: from the seeded tree below, npm was measured not to apply a
# "name@<range>" key to such an edge, and put the old version back, nested.
#
# Why not a plain `npm install --package-lock-only`: it resolves every
# transitive dependency afresh against the registry, so the lock would carry
# newer releases than the tested ones. Instead the lock is seeded from the
# tree pnpm deploys from pnpm-lock.yaml (node-linker=hoisted lays it out the
# way npm does), which npm reads as an existing install and keeps. npm records
# no integrity hash for a tree it did not download itself; writing the lock as
# lockfile v1 first, then converting it to v3, makes npm fetch each package's
# metadata and record them.
#
# Needs pnpm and access to the npm registry. The work directory lives under
# the repository's node_modules/ (ignored by git) because pnpm deploy fails
# when its target sits on another Windows drive than the repository.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMG="$REPO_ROOT/infra/runtime-image"
WORK="$REPO_ROOT/node_modules/.cache/skrun-image-locks"
# The npm that ships with the Node version pinned in .mise.toml, i.e. the npm
# that runs `npm ci` in the image. Bump it with that Node version.
NPM_VERSION="10.9.9"

# regen <block> <workspace package> [pnpm deploy flags...]
regen() {
  local block="$1" pkg="$2"
  shift 2
  local dir="$WORK/$block"
  rm -rf "$dir"
  mkdir -p "$WORK"
  (cd "$REPO_ROOT" && pnpm --filter "$pkg" --config.inject-workspace-packages=true deploy "$@" \
    --ignore-scripts --config.node-linker=hoisted "$dir" >/dev/null)
  # Keep the third-party tree only: the image extracts the @skrun-dev tarballs
  # itself, and the block's own manifest replaces the deployed package's.
  rm -rf "$dir/node_modules/@skrun-dev" "$dir/node_modules/.pnpm" "$dir/node_modules/.bin" \
    "$dir/node_modules/.modules.yaml" "$dir/package-lock.json" "$dir/pnpm-lock.yaml"
  cp "$IMG/$block/package.json" "$dir/package.json"
  # The second pass prints npm's "old lockfile ... one-time fix-up" warnings:
  # that fix-up is the step that fetches the integrity hashes.
  (
    cd "$dir"
    npx --yes "npm@$NPM_VERSION" install --package-lock-only --ignore-scripts --no-audit \
      --no-fund --lockfile-version=1 >/dev/null
    rm -rf node_modules
    npx --yes "npm@$NPM_VERSION" install --package-lock-only --ignore-scripts --no-audit \
      --no-fund --lockfile-version=3 >/dev/null
  )
  cp "$dir/package-lock.json" "$IMG/$block/package-lock.json"
  rm -rf "$dir"
  echo "update-locks: infra/runtime-image/$block/package-lock.json written"
}

# The runner compiles itself with tsc, so its seed keeps devDependencies
# (typescript and @types/node come from the runtime's own tree).
regen runner @skrun-dev/runtime
# The API ships built: production dependencies only, as `npm ci --omit=dev`
# installs them.
regen api-server @skrun-dev/api --prod
rmdir "$WORK" 2>/dev/null || true
