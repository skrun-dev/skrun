import { describe, expect, it } from "vitest";
import { buildCreateKeyInput } from "./keys.js";

describe("buildCreateKeyInput (skrun keys create flags → POST /api/keys payload)", () => {
  it("VT-26: default is an account-wide full key (no scopes)", () => {
    expect(buildCreateKeyInput({ name: "ci" })).toEqual({
      name: "ci",
      scope_kind: "account",
      agents: [],
      scopes: undefined,
    });
  });

  it("VT-26: --agent scopes the key to that one agent", () => {
    expect(buildCreateKeyInput({ name: "client-acme", agent: "dev/my-agent" })).toEqual({
      name: "client-acme",
      scope_kind: "agents",
      agents: ["dev/my-agent"],
      scopes: undefined,
    });
  });

  it("VT-26: --run-only narrows the operation scopes to agent:run", () => {
    expect(buildCreateKeyInput({ name: "runner", runOnly: true })).toEqual({
      name: "runner",
      scope_kind: "account",
      agents: [],
      scopes: ["agent:run"],
    });
  });

  it("VT-26: --agent + --run-only = a delegated run-only client key", () => {
    expect(
      buildCreateKeyInput({ name: "client-acme", agent: "dev/my-agent", runOnly: true }),
    ).toEqual({
      name: "client-acme",
      scope_kind: "agents",
      agents: ["dev/my-agent"],
      scopes: ["agent:run"],
    });
  });
});
