// Module-level singleton for the script-dependency cache. Shared across
// every POST /run handler in the registry — content-addressable, so two
// agents whose manifests have identical text reuse the same install.
//
// Backing storage: `~/.skrun/deps/<hash>/` (overridable via SKRUN_DEPS_DIR).

import { DepsCache } from "@skrun-dev/runtime";

export const depsCache = new DepsCache();
