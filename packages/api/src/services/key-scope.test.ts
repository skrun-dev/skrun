import { describe, expect, it } from "vitest";
import type { Agent } from "../db/schema.js";
import type { KeyContext, UserContext } from "../types.js";
import {
  assertKeyCanPushOrThrow,
  assertKeyCanReadAgentOrThrow,
  assertKeyScopeOrThrow,
  assertMasterCredentialOrThrow,
  assertNotDelegatedOrThrow,
  isDelegatedKey,
  isMasterCredential,
  keyAllowsOperation,
  keyCanAccessAgent,
} from "./key-scope.js";
import { RegistryError } from "./registry.js";

function agent(id: string): Agent {
  return {
    id,
    namespace: "ns",
    name: id,
    description: "",
    owner_id: "owner-1",
    visibility: "private",
    created_at: "",
    updated_at: "",
  } as Agent;
}

function user(key: KeyContext | null, role: "admin" | "user" = "user"): UserContext {
  return { id: "owner-1", namespace: "ns", username: "ns", role, key };
}

// ── The 5 credential shapes ──────────────────────────────────────────────
const sessionUser = user(null); // session cookie
const devTokenUser = user(null, "admin"); // dev-token (admin, no key)
const accountFull: KeyContext = {
  id: "k1",
  scope_kind: "account",
  operations: ["agent:run", "agent:push", "agent:verify"],
  agent_ids: [],
};
const accountRunOnly: KeyContext = {
  id: "k2",
  scope_kind: "account",
  operations: ["agent:run"],
  agent_ids: [],
};
const scopedRun: KeyContext = {
  id: "k3",
  scope_kind: "agents",
  operations: ["agent:run"],
  agent_ids: ["A"],
};

function expectScope403(fn: () => void): void {
  expect(fn).toThrow(RegistryError);
  try {
    fn();
  } catch (e) {
    expect((e as RegistryError).code).toBe("KEY_SCOPE_FORBIDDEN");
    expect((e as RegistryError).status).toBe(403);
  }
}

describe("key-scope: keyAllowsOperation", () => {
  it("null key (session/dev-token) permits everything", () => {
    expect(keyAllowsOperation(null, "agent:run")).toBe(true);
    expect(keyAllowsOperation(null, "agent:push")).toBe(true);
  });
  it("checks the key's operation list", () => {
    expect(keyAllowsOperation(accountFull, "agent:push")).toBe(true);
    expect(keyAllowsOperation(accountRunOnly, "agent:run")).toBe(true);
    expect(keyAllowsOperation(accountRunOnly, "agent:push")).toBe(false);
  });
  it("an empty operation list denies everything (fail-closed)", () => {
    const empty: KeyContext = { id: "e", scope_kind: "account", operations: [], agent_ids: [] };
    expect(keyAllowsOperation(empty, "agent:run")).toBe(false);
  });
});

describe("key-scope: keyCanAccessAgent", () => {
  it("null key or account key → any agent", () => {
    expect(keyCanAccessAgent(null, agent("A"))).toBe(true);
    expect(keyCanAccessAgent(accountFull, agent("Z"))).toBe(true);
    expect(keyCanAccessAgent(accountRunOnly, agent("Z"))).toBe(true);
  });
  it("scoped key → only granted agents", () => {
    expect(keyCanAccessAgent(scopedRun, agent("A"))).toBe(true);
    expect(keyCanAccessAgent(scopedRun, agent("B"))).toBe(false);
  });
  it("scoped key with 0 grants → deny-all (fail-closed)", () => {
    const emptyGrants: KeyContext = {
      id: "g",
      scope_kind: "agents",
      operations: ["agent:run"],
      agent_ids: [],
    };
    expect(keyCanAccessAgent(emptyGrants, agent("A"))).toBe(false);
  });
});

describe("key-scope: isDelegatedKey", () => {
  it("only an agents-scoped key is delegated", () => {
    expect(isDelegatedKey(sessionUser)).toBe(false);
    expect(isDelegatedKey(user(accountFull))).toBe(false);
    expect(isDelegatedKey(user(accountRunOnly))).toBe(false);
    expect(isDelegatedKey(user(scopedRun))).toBe(true);
  });
});

describe("key-scope: isMasterCredential", () => {
  it("session, dev-token, and account+full are master", () => {
    expect(isMasterCredential(sessionUser)).toBe(true);
    expect(isMasterCredential(devTokenUser)).toBe(true);
    expect(isMasterCredential(user(accountFull))).toBe(true);
  });
  it("account-run-only and scoped keys are NOT master", () => {
    expect(isMasterCredential(user(accountRunOnly))).toBe(false);
    expect(isMasterCredential(user(scopedRun))).toBe(false);
  });
  it("an admin presenting a restricted key is NOT master (key-based, not role)", () => {
    expect(isMasterCredential(user(scopedRun, "admin"))).toBe(false);
    expect(isMasterCredential(user(accountRunOnly, "admin"))).toBe(false);
  });
  it("full-ops comparison is order-independent (set equality)", () => {
    const reordered: KeyContext = {
      id: "r",
      scope_kind: "account",
      operations: ["agent:verify", "agent:run", "agent:push"],
      agent_ids: [],
    };
    expect(isMasterCredential(user(reordered))).toBe(true);
  });
  it("an account key with an unknown/extra op is not master", () => {
    const extra: KeyContext = {
      id: "x",
      scope_kind: "account",
      operations: ["agent:run", "agent:push", "agent:verify", "agent:weird"],
      agent_ids: [],
    };
    expect(isMasterCredential(user(extra))).toBe(false);
  });
});

describe("key-scope: assertKeyScopeOrThrow (R1)", () => {
  it("null key never throws", () => {
    expect(() => assertKeyScopeOrThrow(sessionUser, agent("A"), "agent:run")).not.toThrow();
  });
  it("scoped key runs its in-scope agent", () => {
    expect(() => assertKeyScopeOrThrow(user(scopedRun), agent("A"), "agent:run")).not.toThrow();
  });
  it("scoped key on an out-of-scope agent → 403", () => {
    expectScope403(() => assertKeyScopeOrThrow(user(scopedRun), agent("B"), "agent:run"));
  });
  it("operation mismatch → 403", () => {
    expectScope403(() => assertKeyScopeOrThrow(user(accountRunOnly), agent("A"), "agent:push"));
  });
  it("empty operations → 403 on any op", () => {
    const empty = user({ id: "e", scope_kind: "account", operations: [], agent_ids: [] });
    expectScope403(() => assertKeyScopeOrThrow(empty, agent("A"), "agent:run"));
  });
});

describe("key-scope: assertKeyCanPushOrThrow (R1 push, new-vs-existing)", () => {
  const scopedPush: KeyContext = {
    id: "kp",
    scope_kind: "agents",
    operations: ["agent:push"],
    agent_ids: ["A"],
  };

  it("account / session / dev-token may create a new agent (null)", () => {
    expect(() => assertKeyCanPushOrThrow(sessionUser, null)).not.toThrow();
    expect(() => assertKeyCanPushOrThrow(devTokenUser, null)).not.toThrow();
    expect(() => assertKeyCanPushOrThrow(user(accountFull), null)).not.toThrow();
  });
  it("a delegated key (even with push) cannot create a new agent → 403", () => {
    expectScope403(() => assertKeyCanPushOrThrow(user(scopedPush), null));
  });
  it("a delegated key pushes its in-scope agent but not others", () => {
    expect(() => assertKeyCanPushOrThrow(user(scopedPush), agent("A"))).not.toThrow();
    expectScope403(() => assertKeyCanPushOrThrow(user(scopedPush), agent("B")));
  });
  it("a key lacking agent:push → 403 (new or existing)", () => {
    expectScope403(() => assertKeyCanPushOrThrow(user(accountRunOnly), agent("A")));
    expectScope403(() => assertKeyCanPushOrThrow(user(accountRunOnly), null));
  });
});

describe("key-scope: assertMasterCredentialOrThrow (R2)", () => {
  it("master credentials pass", () => {
    expect(() => assertMasterCredentialOrThrow(sessionUser)).not.toThrow();
    expect(() => assertMasterCredentialOrThrow(devTokenUser)).not.toThrow();
    expect(() => assertMasterCredentialOrThrow(user(accountFull))).not.toThrow();
  });
  it("a run-only account key cannot do account-management → 403 (no escalation)", () => {
    expectScope403(() => assertMasterCredentialOrThrow(user(accountRunOnly)));
  });
  it("a delegated key cannot do account-management → 403", () => {
    expectScope403(() => assertMasterCredentialOrThrow(user(scopedRun)));
  });
});

describe("key-scope: assertKeyCanReadAgentOrThrow (R3 metadata)", () => {
  it("account / session read any agent's metadata", () => {
    expect(() => assertKeyCanReadAgentOrThrow(sessionUser, agent("Z"))).not.toThrow();
    expect(() => assertKeyCanReadAgentOrThrow(user(accountRunOnly), agent("Z"))).not.toThrow();
  });
  it("delegated key reads only its in-scope agents", () => {
    expect(() => assertKeyCanReadAgentOrThrow(user(scopedRun), agent("A"))).not.toThrow();
    expectScope403(() => assertKeyCanReadAgentOrThrow(user(scopedRun), agent("B")));
  });
});

describe("key-scope: assertNotDelegatedOrThrow (R3 source/history)", () => {
  it("account / session / dev-token pass", () => {
    expect(() => assertNotDelegatedOrThrow(sessionUser)).not.toThrow();
    expect(() => assertNotDelegatedOrThrow(devTokenUser)).not.toThrow();
    expect(() => assertNotDelegatedOrThrow(user(accountFull))).not.toThrow();
    expect(() => assertNotDelegatedOrThrow(user(accountRunOnly))).not.toThrow();
  });
  it("a delegated key cannot read source/history → 403", () => {
    expectScope403(() => assertNotDelegatedOrThrow(user(scopedRun)));
  });
});
