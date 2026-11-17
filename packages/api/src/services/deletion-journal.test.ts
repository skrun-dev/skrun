import { describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "../storage/memory.js";
import {
  createDeletionJournal,
  DELETION_JOURNAL_PREFIX,
  parseDeletionKey,
  readDeletionJournal,
} from "./deletion-journal.js";

const ID = "0b6f7c2e-4d1a-4c3b-9e8f-1a2b3c4d5e6f";

describe("readDeletionJournal", () => {
  const refusal = (value: string) =>
    `SKRUN_DELETION_JOURNAL must be true or false (got "${value}"). Unset it to keep no deletion journal.`;

  it("unset, the journal is off — the suite inherits no value from the shell that runs it", () => {
    expect(readDeletionJournal({})).toBe(false);
    expect(readDeletionJournal()).toBe(false);
  });

  it.each([
    ["true", true],
    [" TRUE ", true],
    ["True", true],
    ["false", false],
    [" FALSE ", false],
  ])("takes %j as %s", (value, expected) => {
    expect(readDeletionJournal({ SKRUN_DELETION_JOURNAL: value })).toBe(expected);
  });

  it.each([
    "",
    " ",
    "1",
    "0",
    "yes",
    "on",
    "maybe",
  ])("refuses %j, naming the variable and the value it got", (value) => {
    expect(() => readDeletionJournal({ SKRUN_DELETION_JOURNAL: value })).toThrow(refusal(value));
  });
});

describe("createDeletionJournal", () => {
  it.each([
    "account",
    "api-key",
  ] as const)("writes one empty object for a deletion of kind %s, named by the id alone", async (kind) => {
    const storage = new MemoryStorage();
    const journal = createDeletionJournal(storage);

    await journal.record(kind, ID);

    const key = `_deletions/${kind}/${ID}`;
    expect(await storage.list(DELETION_JOURNAL_PREFIX)).toEqual([key]);
    expect((await storage.get(key))?.length).toBe(0);
  });

  it("writes an id given in capitals in lower case, the one form the journal is read in", async () => {
    const storage = new MemoryStorage();
    const journal = createDeletionJournal(storage);

    await journal.record("api-key", ID.toUpperCase());

    expect(await storage.list(DELETION_JOURNAL_PREFIX)).toEqual([`_deletions/api-key/${ID}`]);
  });

  it("rejects when the store does, and writes nothing", async () => {
    const storage = new MemoryStorage();
    const failure = new Error("store unreachable");
    vi.spyOn(storage, "put").mockRejectedValue(failure);
    const journal = createDeletionJournal(storage);

    await expect(journal.record("account", ID)).rejects.toBe(failure);
    expect(await storage.list(DELETION_JOURNAL_PREFIX)).toEqual([]);
  });
});

describe("parseDeletionKey", () => {
  it.each([
    "account",
    "api-key",
  ] as const)("reads back the kind %s and the id of a key the journal writes", async (kind) => {
    const storage = new MemoryStorage();
    await createDeletionJournal(storage).record(kind, ID.toUpperCase());
    const [key] = await storage.list(DELETION_JOURNAL_PREFIX);

    expect(parseDeletionKey(key as string)).toEqual({ kind, id: ID });
  });

  it.each([
    ["an id that is not a UUID", "_deletions/account/not-a-uuid"],
    ["an id in capitals", `_deletions/account/${ID.toUpperCase()}`],
    ["an id with a character more", `_deletions/api-key/${ID}0`],
    ["another kind", `_deletions/agent/${ID}`],
    ["another prefix", `deletions/account/${ID}`],
    ["a bundle's key", `alice/tool/${ID}`],
    ["a sub-folder", `_deletions/account/${ID}/x`],
    ["a folder in between", `_deletions/x/account/${ID}`],
    ["the kind's folder alone", "_deletions/account/"],
  ])("returns null for %s", (_label, key) => {
    expect(parseDeletionKey(key)).toBeNull();
  });
});
