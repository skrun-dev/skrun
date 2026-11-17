import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The runtime image installs its Node dependencies with `npm ci`, one lock per
// block, and extracts the @skrun-dev tarballs beside them. Those locks must hold
// the versions pnpm-lock.yaml resolved — the ones every other test here ran
// against — or the image ships code nobody tested. update-locks.sh writes them
// that way, from the tree pnpm deploys. What this file can check without resolving anything:
// the direct pins equal pnpm-lock.yaml's, each lock was written from its
// manifest, and every name@version a lock holds is one pnpm-lock.yaml holds,
// with the same integrity. Membership, not resolution: a lock edited by hand to
// another version that pnpm-lock.yaml holds for another path would pass.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const RECIPE =
  "The image's install manifests no longer match pnpm-lock.yaml. To fix: (1) in " +
  "infra/runtime-image/runner/package.json and infra/runtime-image/api-server/package.json, " +
  "set every version named below to the one pnpm-lock.yaml resolved; (2) run " +
  "`bash infra/runtime-image/update-locks.sh`, which rewrites both package-lock.json files " +
  "from pnpm-lock.yaml; (3) run `pnpm test:e2e` again. Problems";

const BLOCKS = [
  { dir: "infra/runtime-image/runner", tarballs: ["schema", "runtime"] },
  { dir: "infra/runtime-image/api-server", tarballs: ["schema", "runtime", "api"] },
];

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  pnpm?: { overrides?: Record<string, unknown> };
}
interface LockEntry {
  name?: string;
  version?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface NpmLock {
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
}
interface PnpmImporterDep {
  version: string;
}
interface PnpmLock {
  lockfileVersion: string;
  importers: Record<
    string,
    {
      dependencies?: Record<string, PnpmImporterDep>;
      devDependencies?: Record<string, PnpmImporterDep>;
    }
  >;
  packages: Record<string, { resolution?: { integrity?: string } }>;
}

const readJson = <T>(rel: string): T => JSON.parse(readFileSync(join(ROOT, rel), "utf-8")) as T;

// pnpm-lock.yaml is YAML and the repository root has no parser of its own:
// borrow the one the schema package depends on.
const YAML = createRequire(join(ROOT, "packages/schema/package.json"))("yaml") as {
  parse(text: string): unknown;
};
const pnpmLock = YAML.parse(readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf-8")) as PnpmLock;

/** name@version → integrity, from the `packages` section of pnpm-lock.yaml. */
const pnpmPackages = new Map<string, string | undefined>(
  Object.entries(pnpmLock.packages ?? {}).map(([key, value]) => [key, value.resolution?.integrity]),
);

/** The versions the workspace importers resolved for `name` (peer suffixes dropped). */
function importerVersions(name: string, importers: string[], withDev: boolean): Set<string> {
  const versions = new Set<string>();
  for (const importer of importers) {
    const entry = pnpmLock.importers[importer];
    const sections = [entry?.dependencies, withDev ? entry?.devDependencies : undefined];
    for (const section of sections) {
      const version = section?.[name]?.version;
      if (version && !version.startsWith("link:")) versions.add(version.replace(/\(.*$/, ""));
    }
  }
  return versions;
}

/** The version a block must pin `name` to: the one its tarballs' importers resolved, else the workspace's. */
function expectedPin(name: string, tarballs: string[]): string | string[] {
  let versions = importerVersions(
    name,
    tarballs.map((t) => `packages/${t}`),
    false,
  );
  if (versions.size === 0) versions = importerVersions(name, Object.keys(pnpmLock.importers), true);
  return versions.size === 1 ? [...versions][0] : [...versions];
}

describe("E2E: the image's install locks follow pnpm-lock.yaml", () => {
  it("reads pnpm-lock.yaml (the shape the checks below rely on)", () => {
    expect(pnpmLock.lockfileVersion).toBe("9.0");
    expect(pnpmPackages.size).toBeGreaterThan(0);
    for (const t of ["schema", "runtime", "api"]) {
      expect(pnpmLock.importers[`packages/${t}`], `importer packages/${t}`).toBeDefined();
    }
  });

  describe.each(BLOCKS)("$dir", ({ dir, tarballs }) => {
    const manifest = readJson<Manifest>(`${dir}/package.json`);
    const lock = readJson<NpmLock>(`${dir}/package-lock.json`);
    const direct = { ...manifest.dependencies, ...manifest.devDependencies };

    it("lists every production dependency of the tarballs it extracts, and never a tarball", () => {
      const problems: string[] = [];
      for (const t of tarballs) {
        const deps = readJson<Manifest>(`packages/${t}/package.json`).dependencies ?? {};
        for (const name of Object.keys(deps)) {
          if (name.startsWith("@skrun-dev/")) continue;
          if (!manifest.dependencies?.[name]) {
            problems.push(
              `${dir}/package.json: ${name} (a dependency of @skrun-dev/${t}) is missing`,
            );
          }
        }
      }
      for (const name of Object.keys(direct)) {
        if (name.startsWith("@skrun-dev/")) {
          problems.push(`${dir}/package.json: ${name} is listed; the image extracts its tarball`);
        }
      }
      expect(problems, RECIPE).toEqual([]);
    });

    it("pins every direct dependency to the version pnpm-lock.yaml resolved", () => {
      const problems: string[] = [];
      for (const [name, pinned] of Object.entries(direct)) {
        const wanted = expectedPin(name, tarballs);
        if (Array.isArray(wanted)) {
          problems.push(
            wanted.length === 0
              ? `${dir}/package.json: ${name} is resolved by no package of the workspace, so pnpm-lock.yaml has no tested version for it`
              : `${dir}/package.json: ${name} resolves to several versions in pnpm-lock.yaml (${wanted.join(", ")})`,
          );
        } else if (pinned !== wanted) {
          problems.push(
            `${dir}/package.json: ${name} is pinned to ${pinned}, pnpm-lock.yaml resolved ${wanted}`,
          );
        }
      }
      expect(problems, RECIPE).toEqual([]);
    });

    it("copies the root pnpm overrides", () => {
      const root = readJson<Manifest>("package.json");
      expect(manifest.overrides, RECIPE).toEqual(root.pnpm?.overrides);
    });

    it("has a lock written from this manifest", () => {
      const problems: string[] = [];
      expect(lock.lockfileVersion).toBe(3);
      const locked = { ...lock.packages[""]?.dependencies, ...lock.packages[""]?.devDependencies };
      for (const name of new Set([...Object.keys(direct), ...Object.keys(locked)])) {
        if (direct[name] !== locked[name]) {
          problems.push(
            `${dir}/package-lock.json: ${name} is ${direct[name] ?? "absent"} in package.json, ${locked[name] ?? "absent"} in the lock`,
          );
        }
      }
      expect(problems, RECIPE).toEqual([]);
    });

    it("locks only packages pnpm-lock.yaml holds, with the same integrity", () => {
      const problems: string[] = [];
      for (const [path, entry] of Object.entries(lock.packages)) {
        if (path === "") continue;
        const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + 13);
        const key = `${name}@${entry.version}`;
        if (!pnpmPackages.has(key)) {
          problems.push(`${dir}/package-lock.json: ${key} (${path}) is not in pnpm-lock.yaml`);
        } else if (!entry.integrity || entry.integrity !== pnpmPackages.get(key)) {
          problems.push(
            `${dir}/package-lock.json: ${key} carries integrity ${entry.integrity ?? "none"}, pnpm-lock.yaml ${pnpmPackages.get(key)}`,
          );
        }
      }
      expect(Object.keys(lock.packages).length).toBeGreaterThan(1);
      expect(problems, RECIPE).toEqual([]);
    });
  });

  it("the check the image smoke runs judges its witness trees correctly", () => {
    const script = join(ROOT, "infra/runtime-image/check-installed-versions.mjs");
    const out = execFileSync(process.execPath, [script, "--self-test"], { encoding: "utf-8" });
    expect(out).toContain("0 judged wrongly");
  });
});
