import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { externalBaseUrl } from "./external-url.js";

function ctx(url: string, headers: Record<string, string> = {}): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    req: { url, header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as Context;
}

describe("externalBaseUrl", () => {
  it("uses X-Forwarded-Proto (https) over the internal http scheme — TLS-terminating proxy", () => {
    expect(
      externalBaseUrl(
        ctx("http://skrun-cloud-api-test.fly.dev/auth/github", {
          "x-forwarded-proto": "https",
          host: "skrun-cloud-api-test.fly.dev",
        }),
      ),
    ).toBe("https://skrun-cloud-api-test.fly.dev");
  });

  it("takes the first value when X-Forwarded-Proto is a comma list", () => {
    expect(
      externalBaseUrl(ctx("http://x/", { "x-forwarded-proto": "https, http", host: "x.fly.dev" })),
    ).toBe("https://x.fly.dev");
  });

  it("falls back to the request scheme + host on localhost (no proxy headers)", () => {
    expect(externalBaseUrl(ctx("http://localhost:4000/auth/github"))).toBe("http://localhost:4000");
  });

  it("prefers the Host header over the internal request host", () => {
    expect(
      externalBaseUrl(
        ctx("http://fly-internal:8080/x", { "x-forwarded-proto": "https", host: "skrun.sh" }),
      ),
    ).toBe("https://skrun.sh");
  });
});
