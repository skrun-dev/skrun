import { describe, expect, it } from "vitest";
import type { Agent } from "../db/schema.js";
import type { KeyContext, UserContext } from "../types.js";
import {
  assertKeyCanPushOrThrow,
  assertKeyCanReadAgentOrThrow,
  assertKeyScopeOrThrow,
  assertMasterCredentialOrThrow,
  assertMasterReadOrThrow,
  assertNotDelegatedOrThrow,
  isDelegatedKey,
  isInstanceAdmin,
  isMasterCredential,
  keyAllowsOperation,
  keyCanAccessAgent,
  mayReadRunFiles,
  mayUseUpload,
  runCaller,
  stateCaller,
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
  it("VT-19: a duplicated operation does not stand in for a missing one", () => {
    // Three entries, every one of them a member of the full set — a length
    // check would call this master. It is not: `agent:verify` is absent.
    const duplicated: KeyContext = {
      id: "d",
      scope_kind: "account",
      operations: ["agent:run", "agent:run", "agent:push"],
      agent_ids: [],
    };
    expect(isMasterCredential(user(duplicated))).toBe(false);
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

describe("key-scope: isInstanceAdmin", () => {
  it("an administrator's session is the instance administrator", () => {
    expect(isInstanceAdmin(user(null, "admin"))).toBe(true);
  });
  it("the dev token is the instance administrator", () => {
    expect(isInstanceAdmin(devTokenUser)).toBe(true);
  });
  it("an administrator's account-wide key with every operation is the instance administrator", () => {
    expect(isInstanceAdmin(user(accountFull, "admin"))).toBe(true);
  });
  it("an administrator's reduced key is not — the key decides, not the role", () => {
    expect(isInstanceAdmin(user(accountRunOnly, "admin"))).toBe(false);
  });
  it("an administrator's delegated key is not, even carrying every operation", () => {
    const delegatedFull: KeyContext = { ...scopedRun, operations: [...accountFull.operations] };
    expect(isInstanceAdmin(user(scopedRun, "admin"))).toBe(false);
    expect(isInstanceAdmin(user(delegatedFull, "admin"))).toBe(false);
  });
  it("an account that is not an administrator never is, whatever its credential", () => {
    expect(isInstanceAdmin(sessionUser)).toBe(false);
    expect(isInstanceAdmin(user(accountFull))).toBe(false);
    expect(isInstanceAdmin(user(accountRunOnly))).toBe(false);
    expect(isInstanceAdmin(user(scopedRun))).toBe(false);
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

// Who the caller of a run is: derived from the authenticated credential alone,
// one case per credential shape.
describe("key-scope: runCaller / stateCaller", () => {
  const accountEmpty: KeyContext = {
    id: "k4",
    scope_kind: "account",
    operations: [],
    agent_ids: [],
  };
  const accountFullReordered: KeyContext = {
    id: "k5",
    scope_kind: "account",
    operations: ["agent:verify", "agent:run", "agent:push"],
    agent_ids: [],
  };
  const scopedFull: KeyContext = {
    id: "k6",
    scope_kind: "agents",
    operations: ["agent:run", "agent:push", "agent:verify"],
    agent_ids: ["A"],
  };

  it("a session is the account", () => {
    expect(runCaller(sessionUser)).toEqual({ kind: "account", userId: "owner-1" });
  });
  it("the dev token is the account", () => {
    expect(runCaller(devTokenUser)).toEqual({ kind: "account", userId: "owner-1" });
  });
  it("an account-wide key with the full operation set is the account", () => {
    expect(runCaller(user(accountFull))).toEqual({ kind: "account", userId: "owner-1" });
  });
  it("the full operation set in another order is still the account", () => {
    expect(runCaller(user(accountFullReordered))).toEqual({ kind: "account", userId: "owner-1" });
  });
  it("an account-wide key with fewer operations is the key, not the account", () => {
    expect(runCaller(user(accountRunOnly))).toEqual({ kind: "key", keyId: "k2" });
    expect(runCaller(user(accountEmpty))).toEqual({ kind: "key", keyId: "k4" });
  });
  it("a delegated key is the key, whatever operations it carries", () => {
    expect(runCaller(user(scopedRun))).toEqual({ kind: "key", keyId: "k3" });
    expect(runCaller(user(scopedFull))).toEqual({ kind: "key", keyId: "k6" });
  });
  it("an admin presenting a reduced key is the key: the key decides, never the role", () => {
    expect(runCaller(user(accountRunOnly, "admin"))).toEqual({ kind: "key", keyId: "k2" });
  });

  it("stateCaller is runCaller for every credential that has an account row", () => {
    for (const u of [
      sessionUser,
      devTokenUser,
      user(accountFull),
      user(accountRunOnly),
      user(scopedRun),
    ]) {
      expect(stateCaller(u)).toEqual(runCaller(u));
    }
  });
  it("stateCaller is null for an account the server could not record", () => {
    const synthetic: UserContext = { ...devTokenUser, syntheticAccount: true };
    expect(stateCaller(synthetic)).toBeNull();
    // The run itself still has a caller: only state is out of reach.
    expect(runCaller(synthetic)).toEqual({ kind: "account", userId: "owner-1" });
  });
});

// Who may read run history, stats and source; whose run files and uploads a
// credential may use. One case per credential shape.
describe("key-scope: reads reserved to a master credential", () => {
  const accountEmpty: KeyContext = {
    id: "k4",
    scope_kind: "account",
    operations: [],
    agent_ids: [],
  };
  const scopedFull: KeyContext = {
    id: "k6",
    scope_kind: "agents",
    operations: ["agent:run", "agent:push", "agent:verify"],
    agent_ids: ["A"],
  };

  function refusal(fn: () => void): RegistryError {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(RegistryError);
      return e as RegistryError;
    }
    throw new Error("expected a refusal");
  }

  it("a session, the dev token and a full account key read", () => {
    expect(() => assertMasterReadOrThrow(sessionUser)).not.toThrow();
    expect(() => assertMasterReadOrThrow(devTokenUser)).not.toThrow();
    expect(() => assertMasterReadOrThrow(user(accountFull))).not.toThrow();
  });

  it("an account key with fewer operations, or none, is refused with a message naming what it takes", () => {
    for (const key of [accountRunOnly, accountEmpty]) {
      const err = refusal(() => assertMasterReadOrThrow(user(key)));
      expect(err.code).toBe("KEY_SCOPE_FORBIDDEN");
      expect(err.status).toBe(403);
      expect(err.message).toBe(
        "Reading this requires full access: a session, the dev token, or an account-wide API key that carries every operation.",
      );
    }
  });

  it("an admin presenting a reduced key is refused: the key decides, never the role", () => {
    expectScope403(() => assertMasterReadOrThrow(user(accountRunOnly, "admin")));
  });

  it("a delegated key keeps its own refusal, whatever operations it carries", () => {
    for (const key of [scopedRun, scopedFull]) {
      const err = refusal(() => assertMasterReadOrThrow(user(key)));
      expect(err.code).toBe("KEY_SCOPE_FORBIDDEN");
      expect(err.status).toBe(403);
      expect(err.message).toBe("This endpoint is not available to a resource-scoped API key.");
    }
  });

  describe("mayReadRunFiles", () => {
    const runOfFull = { user_id: "owner-1", api_key_id: "k1" };
    const runOfRunOnly = { user_id: "owner-1", api_key_id: "k2" };
    const runOfDelegated = { user_id: "owner-1", api_key_id: "k3" };
    const runOfSession = { user_id: "owner-1", api_key_id: null };
    const runOfAnotherAccount = { user_id: "owner-2", api_key_id: "k2" };
    const runOfRemovedAccount = { user_id: null, api_key_id: "k2" };

    it("a master credential reads the files of every run of its account", () => {
      for (const u of [sessionUser, devTokenUser, user(accountFull)]) {
        for (const run of [runOfFull, runOfRunOnly, runOfDelegated, runOfSession]) {
          expect(mayReadRunFiles(u, run)).toBe(true);
        }
      }
    });

    it("any other key reads the files of the runs it launched, and no other", () => {
      expect(mayReadRunFiles(user(accountRunOnly), runOfRunOnly)).toBe(true);
      expect(mayReadRunFiles(user(scopedRun), runOfDelegated)).toBe(true);
      for (const run of [runOfFull, runOfDelegated, runOfSession]) {
        expect(mayReadRunFiles(user(accountRunOnly), run)).toBe(false);
      }
      for (const run of [runOfFull, runOfRunOnly, runOfSession]) {
        expect(mayReadRunFiles(user(scopedRun), run)).toBe(false);
      }
    });

    it("a run whose launching key was revoked is read by no key that is not master", () => {
      const revoked = { user_id: "owner-1", api_key_id: null };
      expect(mayReadRunFiles(user(accountRunOnly), revoked)).toBe(false);
      expect(mayReadRunFiles(sessionUser, revoked)).toBe(true);
    });

    it("no credential reads the files of another account's run, or of a run whose account is gone", () => {
      for (const u of [sessionUser, devTokenUser, user(accountFull), user(accountRunOnly)]) {
        expect(mayReadRunFiles(u, runOfAnotherAccount)).toBe(false);
        expect(mayReadRunFiles(u, runOfRemovedAccount)).toBe(false);
      }
    });
  });

  describe("mayUseUpload", () => {
    const byFull = { owner_id: "owner-1", uploaded_by_key_id: "k1" };
    const byRunOnly = { owner_id: "owner-1", uploaded_by_key_id: "k2" };
    const byDelegated = { owner_id: "owner-1", uploaded_by_key_id: "k3" };
    const bySession = { owner_id: "owner-1", uploaded_by_key_id: null };
    const byAnotherAccount = { owner_id: "owner-2", uploaded_by_key_id: "k2" };

    it("a master credential uses every upload of its account", () => {
      for (const u of [sessionUser, devTokenUser, user(accountFull)]) {
        for (const upload of [byFull, byRunOnly, byDelegated, bySession]) {
          expect(mayUseUpload(u, upload)).toBe(true);
        }
      }
    });

    it("any other key uses the uploads it made, and no other", () => {
      expect(mayUseUpload(user(accountRunOnly), byRunOnly)).toBe(true);
      expect(mayUseUpload(user(scopedRun), byDelegated)).toBe(true);
      for (const upload of [byFull, byDelegated, bySession]) {
        expect(mayUseUpload(user(accountRunOnly), upload)).toBe(false);
      }
      for (const upload of [byFull, byRunOnly, bySession]) {
        expect(mayUseUpload(user(scopedRun), upload)).toBe(false);
      }
    });

    it("no credential uses another account's upload", () => {
      for (const u of [sessionUser, devTokenUser, user(accountFull), user(accountRunOnly)]) {
        expect(mayUseUpload(u, byAnotherAccount)).toBe(false);
      }
    });
  });
});
