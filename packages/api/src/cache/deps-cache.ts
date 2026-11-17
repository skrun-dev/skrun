// Module-level singleton for the script-dependency cache. Shared across
// every POST /run handler in the registry that runs agent scripts itself (the
// local runtime) — content-addressable, so two agents whose manifests have
// identical text reuse the same install. On the cloud runtime it is never used:
// each sandbox runner installs its own run's dependencies.
//
// Backing storage: `~/.skrun/deps/<hash>/` (overridable via SKRUN_DEPS_DIR).

import { DepsCache } from "@skrun-dev/runtime";

export const depsCache = new DepsCache();
