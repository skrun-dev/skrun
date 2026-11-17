/**
 * Test-support module, not a test file: write one version of an agent to the
 * store and the database directly, without the push route — for a test that
 * runs a version the push would refuse today, as a version published before
 * that refusal can still be.
 *
 * What it writes is what `RegistryService.push` writes once its checks have
 * passed: the agent, created when missing and owned by the token's account
 * (read from `GET /api/me`, which also creates a development token's user);
 * the bundle — `agent.yaml` and a `SKILL.md`, packed as the CLI packs them —
 * at the key a push stores it under; and the version row, with the bundle's
 * checksum and the configuration it declares as its snapshot. With
 * `verified`, the version is marked verified as well.
 *
 * Given `bundle` instead of `agentYaml`, it stores those bytes as they are,
 * with no snapshot: what a push stored, before it refused one, of a bundle
 * that does not load — not an archive, no `agent.yaml`, an invalid one.
 *
 * What it is not: a byte-for-byte copy of a version an older server stored.
 * The bundle carries exactly the `agent.yaml` given, but the snapshot is that
 * file parsed by today's schema, which keeps no `environment.filesystem` and
 * adds no empty `environment.secrets` — a snapshot an older server recorded
 * kept both. No reader depends on either: the run route reads only the
 * timeout from a snapshot, and the version list returns the snapshot as
 * recorded.
 */
import { createHash } from "node:crypto";
import { packAgentTar, parseAgentYaml } from "@skrun-dev/schema";
import type { Hono } from "hono";
import type { DbAdapter } from "../db/adapter.js";
import type { StorageAdapter } from "../storage/adapter.js";

interface StoredVersionOf {
  /** The app whose `GET /api/me` names the token's account. */
  app: Hono;
  /** The store and the database that app was built on. */
  storage: StorageAdapter;
  db: DbAdapter;
  /** A token of the account that owns the agent. */
  token: string;
  namespace: string;
  name: string;
  version: string;
  /** Mark the version verified, as an administrator would. */
  verified?: boolean;
}

export type StoredVersion = StoredVersionOf &
  (
    | {
        /** The `agent.yaml` of the bundle, as written. */
        agentYaml: string;
        bundle?: never;
      }
    | {
        /** The bundle's bytes, stored as they are, with no snapshot. */
        bundle: Buffer;
        agentYaml?: never;
      }
  );

/** Write `namespace/name` at `version` to storage directly; see the module's comment. */
export async function storeVersion(opts: StoredVersion): Promise<void> {
  const { app, storage, db, token, namespace, name, version, agentYaml } = opts;
  const me = await app.request("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  if (me.status !== 200) {
    throw new Error(`GET /api/me answered ${me.status}: ${await me.text()}`);
  }
  const { id: ownerId } = (await me.json()) as { id: string };

  const bundle =
    opts.agentYaml === undefined
      ? opts.bundle
      : await packAgentTar([
          { name: "agent.yaml", content: Buffer.from(opts.agentYaml) },
          { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
        ]);
  const agent =
    (await db.getAgent(namespace, name)) ??
    (await db.createAgent({ name, namespace, description: "", owner_id: ownerId }));
  const bundleKey = `${namespace}/${name}/${version}.agent`;
  await storage.put(bundleKey, bundle);
  await db.createVersion(agent.id, {
    version,
    size: bundle.length,
    bundle_key: bundleKey,
    bundle_sha256: createHash("sha256").update(bundle).digest("hex"),
    config_snapshot:
      agentYaml === undefined
        ? undefined
        : (parseAgentYaml(agentYaml).config as unknown as Record<string, unknown>),
    notes: null,
  });
  if (opts.verified) await db.setVersionVerified(namespace, name, version, true);
}
