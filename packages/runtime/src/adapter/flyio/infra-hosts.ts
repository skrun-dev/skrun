import { INSTALL_REGISTRY_ALLOWLIST } from "../../tools/script-deps-installers.js";

/**
 * The key a probe URL is presigned for. Never fetched: the URL only shows which
 * host the object store answers on.
 */
export const STORAGE_HOST_PROBE_KEY = "storage-host-probe";
/** Lifetime of that probe URL, in seconds — it is read at once, never used. */
const STORAGE_HOST_PROBE_TTL_S = 60;

/**
 * The hosts a runner must reach for its own infrastructure, whatever its agent
 * declares: the install-time package registries, and the object store it
 * fetches the bundle from at `/init`. The runner's egress rules are set at boot,
 * before any run value reaches it, so this list travels in the machine's
 * environment.
 *
 * The store's host is visible only on a presigned URL, so one is made for a
 * probe key — never fetched — and its host read. A URL that cannot be read
 * leaves the registries alone rather than failing: the runner would then fail
 * at the bundle download, loudly.
 *
 * One definition for both ways a runner is obtained: a machine created for a
 * run, and a pooled one, built before any run exists.
 */
export async function storageInfraHosts(storage: {
  getPresignedDownloadUrl(key: string, expiresIn: number): Promise<string>;
}): Promise<string[]> {
  const hosts = new Set<string>(INSTALL_REGISTRY_ALLOWLIST);
  const probe = await storage.getPresignedDownloadUrl(
    STORAGE_HOST_PROBE_KEY,
    STORAGE_HOST_PROBE_TTL_S,
  );
  try {
    hosts.add(new URL(probe).hostname);
  } catch {
    // Not a URL: the registries alone — see above.
  }
  return [...hosts];
}
