import { describe, expect, it } from "vitest";
import type { Agent } from "../db/schema.js";
import type { UserContext } from "../types.js";
import { assertAgentRunnableOrThrow, assertAgentVisibleOrThrow } from "./access.js";
import { RegistryError } from "./registry.js";

function makeUser(id: string, role: "admin" | "user" = "user"): UserContext {
  return { id, namespace: id, username: id, role };
}

function makeAgent(ownerId: string, visibility: "private" | "public" = "private"): Agent {
  return {
    id: "agent-1",
    name: "foo",
    namespace: "ns",
    description: "",
    owner_id: ownerId,
    visibility,
    created_at: "2026-05-21T00:00:00Z",
    updated_at: "2026-05-21T00:00:00Z",
  };
}

describe("assertAgentVisibleOrThrow", () => {
  it("VT-helper-1: agent==null → throws NOT_FOUND 404", () => {
    expect(() => assertAgentVisibleOrThrow(null, makeUser("u1"), "ns", "foo")).toThrow(
      RegistryError,
    );
    try {
      assertAgentVisibleOrThrow(null, makeUser("u1"), "ns", "foo");
    } catch (e) {
      const err = e as RegistryError;
      expect(err.code).toBe("NOT_FOUND");
      expect(err.status).toBe(404);
      expect(err.message).toBe("Agent ns/foo not found");
    }
  });

  it("VT-helper-2: non-owner non-admin → throws SAME NOT_FOUND 404 (opacity by design)", () => {
    const agent = makeAgent("user-A");
    expect(() => assertAgentVisibleOrThrow(agent, makeUser("user-B"), "ns", "foo")).toThrow(
      RegistryError,
    );
    try {
      assertAgentVisibleOrThrow(agent, makeUser("user-B"), "ns", "foo");
    } catch (e) {
      const err = e as RegistryError;
      expect(err.code).toBe("NOT_FOUND");
      expect(err.status).toBe(404);
      expect(err.message).toBe("Agent ns/foo not found");
    }
  });

  it("VT-helper-3: owner → no throw, narrows Agent | null → Agent", () => {
    const agent = makeAgent("user-A");
    expect(() => assertAgentVisibleOrThrow(agent, makeUser("user-A"), "ns", "foo")).not.toThrow();
  });

  it("VT-helper-4: admin → no throw even cross-namespace (admin bypass)", () => {
    const agent = makeAgent("user-A");
    const admin = makeUser("admin-1", "admin");
    expect(() => assertAgentVisibleOrThrow(agent, admin, "ns", "foo")).not.toThrow();
  });

  it("VT-helper-5: genuine-404 and ownership-404 produce byte-identical error shape (SC-8b foundation)", () => {
    let genuineErr: RegistryError | undefined;
    let ownershipErr: RegistryError | undefined;
    try {
      assertAgentVisibleOrThrow(null, makeUser("u1"), "ns", "foo");
    } catch (e) {
      genuineErr = e as RegistryError;
    }
    try {
      assertAgentVisibleOrThrow(makeAgent("user-A"), makeUser("user-B"), "ns", "foo");
    } catch (e) {
      ownershipErr = e as RegistryError;
    }
    expect(genuineErr).toBeDefined();
    expect(ownershipErr).toBeDefined();
    if (!genuineErr || !ownershipErr) {
      throw new Error("test invariant: both errors must be defined");
    }
    // Identical code, message, status, name — no client-side discriminator.
    // Any future divergence here would reintroduce existence leak.
    expect(genuineErr.code).toBe(ownershipErr.code);
    expect(genuineErr.message).toBe(ownershipErr.message);
    expect(genuineErr.status).toBe(ownershipErr.status);
    expect(genuineErr.name).toBe(ownershipErr.name);
  });
});

describe("assertAgentRunnableOrThrow", () => {
  it("public agent → any authenticated caller may run (no throw)", () => {
    const agent = makeAgent("user-A", "public");
    expect(() => assertAgentRunnableOrThrow(agent, makeUser("user-B"), "ns", "foo")).not.toThrow();
  });

  it("private agent → owner may run (no throw)", () => {
    const agent = makeAgent("user-A", "private");
    expect(() => assertAgentRunnableOrThrow(agent, makeUser("user-A"), "ns", "foo")).not.toThrow();
  });

  it("private agent → admin may run (no throw)", () => {
    const agent = makeAgent("user-A", "private");
    const admin = makeUser("admin-1", "admin");
    expect(() => assertAgentRunnableOrThrow(agent, admin, "ns", "foo")).not.toThrow();
  });

  it("private agent → non-owner non-admin throws NOT_FOUND 404 (opaque)", () => {
    const agent = makeAgent("user-A", "private");
    try {
      assertAgentRunnableOrThrow(agent, makeUser("user-B"), "ns", "foo");
      throw new Error("expected throw");
    } catch (e) {
      const err = e as RegistryError;
      expect(err.code).toBe("NOT_FOUND");
      expect(err.status).toBe(404);
      expect(err.message).toBe("Agent ns/foo not found");
    }
  });

  it("agent==null → throws NOT_FOUND 404", () => {
    expect(() => assertAgentRunnableOrThrow(null, makeUser("u1"), "ns", "foo")).toThrow(
      RegistryError,
    );
  });

  it("run-path 404 is byte-identical to the read-path 404 (delegation invariant)", () => {
    let runErr: RegistryError | undefined;
    let readErr: RegistryError | undefined;
    try {
      assertAgentRunnableOrThrow(makeAgent("user-A", "private"), makeUser("user-B"), "ns", "foo");
    } catch (e) {
      runErr = e as RegistryError;
    }
    try {
      assertAgentVisibleOrThrow(makeAgent("user-A", "private"), makeUser("user-B"), "ns", "foo");
    } catch (e) {
      readErr = e as RegistryError;
    }
    if (!runErr || !readErr) throw new Error("test invariant: both errors must be defined");
    expect(runErr.code).toBe(readErr.code);
    expect(runErr.message).toBe(readErr.message);
    expect(runErr.status).toBe(readErr.status);
    expect(runErr.name).toBe(readErr.name);
  });
});
