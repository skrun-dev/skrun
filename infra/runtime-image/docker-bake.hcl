# docker-bake.hcl — multi-target build for the skrun-runtime image.
#
# The shared `base` stage is built ONCE (BuildKit dedups it within a single bake
# run); the two targets sit on top of it (see the Dockerfile):
#   - api-server -> GHCR       (self-host default: :edge / :latest / :vX.Y.Z)
#   - runner     -> registry.fly.io  (slim cloud image, faster cold pull)
#
# Per-target gha cache scopes so the two targets do NOT evict each other's cache
# across runs: a single unscoped `type=gha` would — the second build's cache-to
# overwrites the first's. Each scope holds the full layer chain (mode=max),
# including the shared base layers, so either target warm-starts on its own scope.
#
# The workflow (runtime-image.yml) overrides the tags per target via `--set`:
#   docker buildx bake -f infra/runtime-image/docker-bake.hcl \
#     --set api-server.tags=<ghcr tags> --set runner.tags=<fly tag> --push

group "default" {
  targets = ["api-server", "runner"]
}

target "_common" {
  context    = "."
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  args = {
    SCHEMA_TGZ  = "skrun-dev-schema.tgz"
    RUNTIME_TGZ = "skrun-dev-runtime.tgz"
    API_TGZ     = "skrun-dev-api.tgz"
  }
}

# Self-host default image (full). Tags injected by the workflow (GHCR matrix).
target "api-server" {
  inherits   = ["_common"]
  target     = "api-server"
  cache-from = ["type=gha,scope=api-server"]
  cache-to   = ["type=gha,scope=api-server,mode=max"]
}

# Slim cloud runner. Tag injected by the workflow (registry.fly.io).
target "runner" {
  inherits   = ["_common"]
  target     = "runner"
  cache-from = ["type=gha,scope=runner"]
  cache-to   = ["type=gha,scope=runner,mode=max"]
}
