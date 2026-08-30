import { describe, expect, it } from "vitest";
import { authorizeRunnerRequest, isRpcAuthorized } from "./rpc-auth.js";

describe("isRpcAuthorized (SEC-2026-002)", () => {
  // VT-2b: unset = enforcement off (back-compat — un-patched api / self-host)
  it("allows any request when no token is configured", () => {
    expect(isRpcAuthorized(undefined, undefined)).toBe(true);
    expect(isRpcAuthorized("Bearer whatever", undefined)).toBe(true);
    expect(isRpcAuthorized(undefined, "")).toBe(true);
  });

  // VT-2: a matching Bearer token authorizes
  it("authorizes a matching Bearer token", () => {
    expect(isRpcAuthorized("Bearer secret-123", "secret-123")).toBe(true);
  });

  // VT-2: wrong / missing / malformed are rejected when a token is configured
  it("rejects a wrong, missing, or malformed token", () => {
    expect(isRpcAuthorized("Bearer wrong-1234", "secret-123")).toBe(false);
    expect(isRpcAuthorized(undefined, "secret-123")).toBe(false);
    expect(isRpcAuthorized("secret-123", "secret-123")).toBe(false); // no Bearer prefix
    expect(isRpcAuthorized("Bearer ", "secret-123")).toBe(false);
    expect(isRpcAuthorized("Bearer secret-12", "secret-123")).toBe(false); // length mismatch
    expect(isRpcAuthorized("Basic secret-123", "secret-123")).toBe(false);
  });
});

describe("authorizeRunnerRequest — the three runner lifecycle states", () => {
  const CLAIM = "claim-cred-0123456789abcdef";
  const RUN = "run-token-0123456789abcdef";
  const PROTECTED = ["/init", "/tool", "/outputs/collect", "/outputs/file"] as const;

  describe("pooled-unclaimed (claim credential set, no run token)", () => {
    const creds = { claimToken: CLAIM };

    it("serves /healthz to anyone — the harness polls it before it can authenticate", () => {
      expect(authorizeRunnerRequest("/healthz", undefined, creds)).toEqual({
        allowed: true,
        state: "pooled-unclaimed",
      });
    });

    it("serves /claim ONLY with the claim credential", () => {
      expect(authorizeRunnerRequest("/claim", `Bearer ${CLAIM}`, creds).allowed).toBe(true);
      expect(authorizeRunnerRequest("/claim", undefined, creds).allowed).toBe(false);
      expect(authorizeRunnerRequest("/claim", `Bearer ${RUN}`, creds).allowed).toBe(false);
      expect(authorizeRunnerRequest("/claim", `Bearer ${CLAIM}x`, creds).allowed).toBe(false);
      expect(authorizeRunnerRequest("/claim", CLAIM, creds).allowed).toBe(false); // no Bearer prefix
    });

    // The reason this function exists: reusing isRpcAuthorized here would return
    // `true` (no run token configured) and expose /init's arbitrary bundleUrl.
    it("denies every other route, with or without a credential", () => {
      for (const path of PROTECTED) {
        expect(authorizeRunnerRequest(path, undefined, creds).allowed).toBe(false);
        expect(authorizeRunnerRequest(path, `Bearer ${CLAIM}`, creds).allowed).toBe(false);
        expect(authorizeRunnerRequest(path, `Bearer ${RUN}`, creds).allowed).toBe(false);
      }
    });
  });

  describe("claimed (run token set)", () => {
    const creds = { runToken: RUN };

    it("keeps the historical per-run-token rule on every protected route", () => {
      for (const path of PROTECTED) {
        expect(authorizeRunnerRequest(path, `Bearer ${RUN}`, creds).allowed).toBe(true);
        expect(authorizeRunnerRequest(path, undefined, creds).allowed).toBe(false);
        expect(authorizeRunnerRequest(path, `Bearer ${CLAIM}`, creds).allowed).toBe(false);
      }
      expect(authorizeRunnerRequest("/healthz", undefined, creds).allowed).toBe(true);
    });

    // Found by the image test: the handler's own 409 is unreachable once a run
    // credential exists, because this decision runs first. The reason has to be
    // carried here or the caller sees a credential error that is not one.
    it("refuses /claim as ALREADY CLAIMED, not as a credential failure", () => {
      const both = { claimToken: CLAIM, runToken: RUN };
      expect(authorizeRunnerRequest("/claim", `Bearer ${CLAIM}`, both)).toEqual({
        allowed: false,
        state: "claimed",
        denial: "already-claimed",
      });
      expect(authorizeRunnerRequest("/claim", undefined, creds).denial).toBe("already-claimed");
    });

    it("refuses /claim — a claimed machine is never re-claimable", () => {
      expect(
        authorizeRunnerRequest("/claim", `Bearer ${CLAIM}`, { claimToken: CLAIM, runToken: RUN })
          .allowed,
      ).toBe(false);
      expect(authorizeRunnerRequest("/claim", `Bearer ${RUN}`, creds).allowed).toBe(false);
    });

    it("lets the run token win even if the claim credential is still present", () => {
      const both = { claimToken: CLAIM, runToken: RUN };
      expect(authorizeRunnerRequest("/init", `Bearer ${RUN}`, both).allowed).toBe(true);
      expect(authorizeRunnerRequest("/init", `Bearer ${CLAIM}`, both).allowed).toBe(false);
      expect(authorizeRunnerRequest("/init", `Bearer ${RUN}`, both).state).toBe("claimed");
    });
  });

  describe("legacy (neither credential) — RT-4, unchanged behaviour", () => {
    const creds = {};

    it("stays open on the historical routes, exactly as isRpcAuthorized does", () => {
      for (const path of [...PROTECTED, "/healthz"]) {
        expect(authorizeRunnerRequest(path, undefined, creds).allowed).toBe(true);
        expect(authorizeRunnerRequest(path, undefined, creds).state).toBe("legacy");
        // parity with the function this path must not diverge from
        expect(authorizeRunnerRequest(path, undefined, creds).allowed).toBe(
          isRpcAuthorized(undefined, undefined),
        );
      }
    });

    it("does NOT extend the open-when-unset rule to /claim", () => {
      expect(authorizeRunnerRequest("/claim", undefined, creds).allowed).toBe(false);
      expect(authorizeRunnerRequest("/claim", `Bearer ${CLAIM}`, creds).allowed).toBe(false);
    });

    it("treats an empty-string credential as absent, like isRpcAuthorized", () => {
      expect(
        authorizeRunnerRequest("/init", undefined, { claimToken: "", runToken: "" }).state,
      ).toBe("legacy");
    });
  });
});
