// `createStateCallbacks`, run against a real MemoryDb: the notebook it reads
// and writes is keyed by the agent's id it is given, never by the slug the
// runtime passes (`config.name`) — so two agents of the same slug in two
// namespaces, two ids, never share a notebook.
//
// This file calls `createStateCallbacks` directly and does not go through
// POST /run: that the route hands it the agent's id is proven by the
// end-to-end tests of the run route (tests/e2e/state-per-caller.test.ts).

import { StateConfigSchema } from "@skrun-dev/schema";
import { describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../db/memory.js";
import { createStateCallbacks } from "../services/agent-state.js";

const log = () => ({ info: vi.fn(), warn: vi.fn() });

async function sameSlugInTwoNamespaces() {
  const db = new MemoryDb();
  const owner = await db.createUser({ github_id: "gh-wiring", username: "wiring" });
  const inDev = await db.createAgent({
    name: "email-drafter",
    namespace: "dev",
    description: "",
    owner_id: owner.id,
  });
  const inTarcroi = await db.createAgent({
    name: "email-drafter",
    namespace: "tarcroi",
    description: "",
    owner_id: owner.id,
  });
  return { db, owner, inDev, inTarcroi };
}

describe("createStateCallbacks on a MemoryDb — the notebook is the agent's id, not its slug", () => {
  it("two agents of the same slug in two namespaces have two ids and two notebooks", async () => {
    const { db, owner, inDev, inTarcroi } = await sameSlugInTwoNamespaces();
    expect(inDev.id).not.toBe(inTarcroi.id);
    const state = StateConfigSchema.parse({ type: "kv" });
    const caller = { kind: "account", userId: owner.id } as const;
    const cbDev = createStateCallbacks({ db, agentId: inDev.id, state, caller, log: log() });
    const cbTarcroi = createStateCallbacks({
      db,
      agentId: inTarcroi.id,
      state,
      caller,
      log: log(),
    });

    await cbDev.setState("email-drafter", { run_count: 1 });
    await cbTarcroi.setState("email-drafter", { run_count: 99 });

    expect(await cbDev.getState("email-drafter")).toEqual({ run_count: 1 });
    expect(await cbTarcroi.getState("email-drafter")).toEqual({ run_count: 99 });
  });

  it("the name the loop passes does not choose the notebook", async () => {
    const { db, owner, inDev } = await sameSlugInTwoNamespaces();
    const cb = createStateCallbacks({
      db,
      agentId: inDev.id,
      state: StateConfigSchema.parse({ type: "kv" }),
      caller: { kind: "account", userId: owner.id },
      log: log(),
    });

    await cb.setState("email-drafter", { written: "under the slug" });
    // Another name — another agent's slug, a namespaced name — reads the same
    // notebook: the name is not part of the key.
    expect(await cb.getState("other-agent")).toEqual({ written: "under the slug" });
    expect(await cb.getState("tarcroi/email-drafter")).toEqual({ written: "under the slug" });
  });
});
