import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryClient } from "./registry-client.js";

describe("RegistryClient.push", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds force=true when requested", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new RegistryClient("http://localhost:4000", "dev-token");
    await client.push(Buffer.from("bundle"), "dev", "agent", "1.0.0", true);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/agents/dev/agent/push?version=1.0.0&force=true",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("omits force=true by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new RegistryClient("http://localhost:4000", "dev-token");
    await client.push(Buffer.from("bundle"), "dev", "agent", "1.0.0");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/agents/dev/agent/push?version=1.0.0",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});
