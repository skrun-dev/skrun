import { describe, expect, it, vi } from "vitest";
import { INSTALL_REGISTRY_ALLOWLIST } from "../../tools/script-deps-installers.js";
import { STORAGE_HOST_PROBE_KEY, storageInfraHosts } from "./infra-hosts.js";

function storagePresigning(url: string) {
  return { getPresignedDownloadUrl: vi.fn(async () => url) };
}

describe("storageInfraHosts", () => {
  it("is the install registries and the host of the object store, read from a probe URL", async () => {
    const storage = storagePresigning("https://acct.r2.example/b/k?sig=1");

    const hosts = await storageInfraHosts(storage);

    expect(hosts).toEqual([...INSTALL_REGISTRY_ALLOWLIST, "acct.r2.example"]);
  });

  it("presigns a probe key, for a short while, and nothing of a run", async () => {
    const storage = storagePresigning("https://acct.r2.example/b/k?sig=1");

    await storageInfraHosts(storage);

    expect(storage.getPresignedDownloadUrl).toHaveBeenCalledOnce();
    expect(storage.getPresignedDownloadUrl).toHaveBeenCalledWith(STORAGE_HOST_PROBE_KEY, 60);
  });

  it("leaves the registries alone, without an error, when the probe URL cannot be read", async () => {
    const hosts = await storageInfraHosts(storagePresigning("not a url"));

    expect(hosts).toEqual([...INSTALL_REGISTRY_ALLOWLIST]);
  });

  it("names a host once, when the store sits on a registry's", async () => {
    const hosts = await storageInfraHosts(storagePresigning("https://pypi.org/b/k?sig=1"));

    expect(hosts).toEqual([...INSTALL_REGISTRY_ALLOWLIST]);
  });
});
