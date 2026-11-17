import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Each published package, the workspace root and the runtime image declare the lowest Node they
// run on. A dependency can raise that floor in silence: it declares its own engines.node, npm and
// pnpm only warn, and the declared floor turns false. This file reads what the locks resolved and
// refuses a floor that a package it would install does not admit:
//  - a published package: its engines.node against every production dependency it pulls,
//    transitively, read in pnpm-lock.yaml (importers, then snapshots, workspace links followed,
//    and the linked workspace packages' own floors);
//  - the workspace root: against every package pnpm-lock.yaml holds, development included. The
//    root has no production dependency; its floor is the one of whoever installs and builds the
//    repository;
//  - the image: the Node pinned in infra/runtime-image/.mise.toml and each install manifest's
//    floor, against every package of that block's npm lock its install keeps — the runner's
//    `npm ci` keeps the development packages it compiles with, the API server's
//    `npm ci --omit=dev` drops them (infra/runtime-image/Dockerfile); and each lock's root
//    declares its manifest's floor.
// A floor is the lowest version its range admits (semver.minVersion). A range semver cannot read
// is a refusal, named. What this does not see: a Node API the code itself uses above its floor
// (nothing declares it), a dependency that declares no engines.node, and the Node the CI runs.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const RECIPE =
  "A declared Node floor no longer admits a package the locks install. To fix: raise the floor " +
  "named below (engines.node of that package.json; for the image, the node of " +
  "infra/runtime-image/.mise.toml, both install manifests and the root of their " +
  "package-lock.json), or pin the dependency to a release that admits it; then make the README's " +
  "Node lines say the same. Refusals";

const PUBLISHED = ["sdk", "schema", "runtime", "api", "cli"] as const;
const BLOCKS = ["runner", "api-server"] as const;

/**
 * Whether a block's install keeps its development packages, as the Dockerfile installs it: the
 * runner's `npm ci` keeps them — its build runs tsc in the image —, the API server's
 * `npm ci --omit=dev` does not.
 */
const KEEPS_DEV: Readonly<Record<(typeof BLOCKS)[number], boolean>> = {
  runner: true,
  "api-server": false,
};

interface SemverApi {
  validRange(range: string): string | null;
  minVersion(range: string): { version: string } | null;
  satisfies(version: string, range: string): boolean;
}
const semver = createRequire(import.meta.url)("semver") as SemverApi;

// pnpm-lock.yaml is YAML and the repository root has no parser of its own: borrow the one the
// schema package depends on, as image-locks.test.ts does.
const YAML = createRequire(join(ROOT, "packages/schema/package.json"))("yaml") as {
  parse(text: string): unknown;
};

interface PnpmImporter {
  dependencies?: Record<string, { version: string }>;
  optionalDependencies?: Record<string, { version: string }>;
  devDependencies?: Record<string, { version: string }>;
}
interface PnpmSnapshot {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
interface PnpmLock {
  lockfileVersion: string;
  importers: Record<string, PnpmImporter>;
  packages: Record<string, { engines?: unknown }>;
  snapshots: Record<string, PnpmSnapshot>;
}
interface NpmLock {
  lockfileVersion: number;
  packages: Record<string, { name?: string; version?: string; dev?: boolean; engines?: unknown }>;
}
interface Manifest {
  name?: string;
  engines?: { node?: string };
}

/** A package that may declare an engines.node. */
interface Declared {
  id: string;
  node: string | undefined;
}

const readText = (rel: string): string => readFileSync(join(ROOT, rel), "utf-8");
const readJson = <T>(rel: string): T => JSON.parse(readText(rel)) as T;

/** engines.node as a lock records it. Anything but a string under an object is kept, as text, so
 * that the rule refuses it as unreadable instead of skipping it. */
function nodeRange(engines: unknown): string | undefined {
  if (engines === undefined || engines === null) return undefined;
  if (typeof engines === "object" && !Array.isArray(engines)) {
    const node = (engines as { node?: unknown }).node;
    if (node === undefined) return undefined;
    return typeof node === "string" ? node : JSON.stringify(node);
  }
  return JSON.stringify(engines);
}

/** The rule, pure: what `owner`'s floor refuses among `packages`. */
function refusals(owner: string, floor: string, packages: Declared[]): string[] {
  const lowest = semver.validRange(floor) ? semver.minVersion(floor)?.version : undefined;
  if (!lowest) return [`${owner}: its floor "${floor}" is not a range semver reads`];
  const out: string[] = [];
  for (const { id, node } of packages) {
    if (node === undefined) continue;
    if (!semver.validRange(node)) {
      out.push(`${owner}: ${id} declares engines.node "${node}", not a range semver reads`);
    } else if (!semver.satisfies(lowest, node)) {
      out.push(`${owner}: floor ${floor} admits Node ${lowest}, ${id} requires ${node}`);
    }
  }
  return out;
}

interface Closure {
  /** Third-party packages, by name@version, with their engines.node. */
  packages: Declared[];
  /** Workspace importers reached through a link: dependency. */
  linked: string[];
  /** References the lock does not resolve: the reading is wrong, never silently short. */
  problems: string[];
}

/** The production closure of a workspace importer: dependencies and optionalDependencies,
 * transitively through `snapshots`, following `link:` into the linked importer's own. */
function productionClosure(lock: PnpmLock, importer: string): Closure {
  const problems: string[] = [];
  const found = new Map<string, string | undefined>();
  const visited = new Set<string>();
  const importers = new Set<string>([importer]);
  const stack: string[] = [];
  const fromImporter = (path: string): void => {
    const entry = lock.importers[path];
    if (!entry) {
      problems.push(`pnpm-lock.yaml has no importer ${path}`);
      return;
    }
    for (const section of [entry.dependencies, entry.optionalDependencies]) {
      for (const [name, { version }] of Object.entries(section ?? {})) {
        if (version.startsWith("link:")) {
          const target = posix.normalize(posix.join(path, version.slice("link:".length)));
          if (!importers.has(target)) {
            importers.add(target);
            fromImporter(target);
          }
        } else {
          stack.push(`${name}@${version}`);
        }
      }
    }
  };
  fromImporter(importer);
  for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
    if (visited.has(key)) continue;
    visited.add(key);
    const id = key.replace(/\(.*$/, "");
    const entry = lock.packages[id];
    if (!entry)
      problems.push(`${importer}: ${id} is reached but pnpm-lock.yaml's packages lacks it`);
    found.set(id, nodeRange(entry?.engines));
    const snapshot = lock.snapshots[key] ?? lock.snapshots[id];
    if (!snapshot) problems.push(`${importer}: ${key} is reached but has no snapshot`);
    for (const section of [snapshot?.dependencies, snapshot?.optionalDependencies]) {
      for (const [name, version] of Object.entries(section ?? {})) stack.push(`${name}@${version}`);
    }
  }
  importers.delete(importer);
  return {
    packages: [...found].map(([id, node]) => ({ id, node })),
    linked: [...importers].sort(),
    problems,
  };
}

/** The packages of an npm lock (v3) an install keeps, with their engines.node: the dev ones only
 * if it keeps them. */
function installedPackages(lock: NpmLock, keepsDev: boolean): Declared[] {
  return Object.entries(lock.packages)
    .filter(([path, entry]) => path !== "" && (keepsDev || entry.dev !== true))
    .map(([path, entry]) => ({
      id: `${entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)}@${entry.version}`,
      node: nodeRange(entry.engines),
    }));
}

/** The node of the [tools] section of a mise config. */
function miseNode(text: string): string | undefined {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const pin = /^node\s*=\s*"([^"]+)"/.exec(line);
    if (section === "tools" && pin) return pin[1];
  }
  return undefined;
}

const pnpmLock = YAML.parse(readText("pnpm-lock.yaml")) as PnpmLock;
const miseText = readText("infra/runtime-image/.mise.toml");
const NONE = "(none)";

describe("E2E: the declared Node floors admit what the locks install", () => {
  it("reads pnpm-lock.yaml, the image's locks and its pinned Node (the shapes the checks rely on)", () => {
    expect(pnpmLock.lockfileVersion).toBe("9.0");
    for (const p of PUBLISHED) {
      expect(pnpmLock.importers[`packages/${p}`], `importer packages/${p}`).toBeDefined();
    }
    for (const p of ["runtime", "api", "cli"]) {
      const closure = productionClosure(pnpmLock, `packages/${p}`);
      expect(closure.packages.length, `production closure of packages/${p}`).toBeGreaterThan(0);
    }
    expect(miseNode(miseText), "node of the [tools] section of .mise.toml").toBeDefined();
    for (const block of BLOCKS) {
      const lock = readJson<NpmLock>(`infra/runtime-image/${block}/package-lock.json`);
      expect(lock.lockfileVersion).toBe(3);
      expect(installedPackages(lock, KEEPS_DEV[block]).length, `${block} lock`).toBeGreaterThan(0);
    }
  });

  it.each(
    PUBLISHED,
  )("@skrun-dev/%s: its floor admits every production dependency it pulls", (p) => {
    const manifest = readJson<Manifest>(`packages/${p}/package.json`);
    const closure = productionClosure(pnpmLock, `packages/${p}`);
    const workspace = closure.linked.map((path) => {
      const linked = readJson<Manifest>(`${path}/package.json`);
      return { id: `${linked.name ?? path} (workspace)`, node: nodeRange(linked.engines) };
    });
    const problems = [
      ...closure.problems,
      ...refusals(`@skrun-dev/${p}`, manifest.engines?.node ?? NONE, [
        ...workspace,
        ...closure.packages,
      ]),
    ];
    expect(problems, RECIPE).toEqual([]);
  });

  it("the workspace root: its floor admits every package pnpm-lock.yaml holds, development included", () => {
    const root = readJson<Manifest>("package.json");
    const all = Object.entries(pnpmLock.packages).map(([id, entry]) => ({
      id,
      node: nodeRange(entry.engines),
    }));
    expect(all.length).toBeGreaterThan(0);
    expect(refusals("the workspace root", root.engines?.node ?? NONE, all), RECIPE).toEqual([]);
  });

  describe.each(BLOCKS)("the image's %s block", (block) => {
    const dir = `infra/runtime-image/${block}`;
    const manifest = readJson<Manifest>(`${dir}/package.json`);
    const lock = readJson<NpmLock>(`${dir}/package-lock.json`);

    it("its pinned Node and its manifest's floor admit every package of its lock its install keeps", () => {
      const installed = installedPackages(lock, KEEPS_DEV[block]);
      const problems = [
        ...refusals(`.mise.toml's node (${block})`, miseNode(miseText) ?? NONE, installed),
        ...refusals(`${dir}/package.json`, manifest.engines?.node ?? NONE, installed),
      ];
      expect(problems, RECIPE).toEqual([]);
    });

    it("its lock's root declares the manifest's floor", () => {
      expect(nodeRange(lock.packages[""]?.engines), `${dir}/package-lock.json root`).toBe(
        manifest.engines?.node,
      );
    });
  });
});

describe("E2E: the floor rule judges its witnesses", () => {
  const witness: PnpmLock = {
    lockfileVersion: "9.0",
    importers: {
      "packages/a": { dependencies: { b: { version: "link:../b" }, x: { version: "1.0.0" } } },
      "packages/b": { dependencies: { y: { version: "2.0.0(x@1.0.0)" } } },
      "packages/c": { dependencies: { x: { version: "1.0.0" } } },
      "packages/d": { dependencies: { q: { version: "9.9.9" } } },
    },
    packages: {
      "x@1.0.0": { engines: { node: ">=18" } },
      "y@2.0.0": {},
      "z@3.0.0": { engines: { node: ">=99.0.0" } },
    },
    snapshots: {
      "x@1.0.0": {},
      "y@2.0.0(x@1.0.0)": { optionalDependencies: { z: "3.0.0" } },
      "z@3.0.0": {},
    },
  };

  it("refuses a closure that pulls a package requiring Node 99, through a link and an optional dependency", () => {
    const closure = productionClosure(witness, "packages/a");
    expect(closure.problems).toEqual([]);
    expect(closure.linked).toEqual(["packages/b"]);
    expect(closure.packages.map((d) => d.id).sort()).toEqual(["x@1.0.0", "y@2.0.0", "z@3.0.0"]);
    expect(refusals("a", ">=22.19.0", closure.packages)).toEqual([
      "a: floor >=22.19.0 admits Node 22.19.0, z@3.0.0 requires >=99.0.0",
    ]);
  });

  it("stays silent on a healthy closure", () => {
    const closure = productionClosure(witness, "packages/c");
    expect(closure.problems).toEqual([]);
    expect(refusals("c", ">=22.0.0", closure.packages)).toEqual([]);
  });

  const imageLock: NpmLock = {
    lockfileVersion: 3,
    packages: {
      "": { engines: { node: ">=22.19.0" } },
      "node_modules/undici": { version: "8.10.0", engines: { node: ">=22.19.0" } },
      "node_modules/tool": { version: "1.0.0", dev: true, engines: { node: ">=99.0.0" } },
    },
  };

  it("refuses an image Node below a dependency's floor, and admits one above it", () => {
    expect(refusals("image", "22.12.0", installedPackages(imageLock, false))).toEqual([
      "image: floor 22.12.0 admits Node 22.12.0, undici@8.10.0 requires >=22.19.0",
    ]);
    expect(refusals("image", "22.23.4", installedPackages(imageLock, false))).toEqual([]);
  });

  it("reads a development package only for an install that keeps them", () => {
    expect(refusals("image", "22.23.4", installedPackages(imageLock, true))).toEqual([
      "image: floor 22.23.4 admits Node 22.23.4, tool@1.0.0 requires >=99.0.0",
    ]);
  });

  it("refuses, by name, a range semver cannot read — a dependency's or the floor itself", () => {
    expect(refusals("a", ">=22.0.0", [{ id: "w@1.0.0", node: "node >= banana" }])).toEqual([
      'a: w@1.0.0 declares engines.node "node >= banana", not a range semver reads',
    ]);
    expect(refusals("a", ">=22.0.0", [{ id: "v@1.0.0", node: nodeRange(["node >=0.8"]) }])).toEqual(
      ['a: v@1.0.0 declares engines.node "["node >=0.8"]", not a range semver reads'],
    );
    expect(refusals("a", NONE, [])).toEqual([`a: its floor "${NONE}" is not a range semver reads`]);
  });

  it("names a reference the lock does not resolve instead of reading a shorter closure", () => {
    const closure = productionClosure(witness, "packages/d");
    expect(closure.problems).toEqual([
      "packages/d: q@9.9.9 is reached but pnpm-lock.yaml's packages lacks it",
      "packages/d: q@9.9.9 is reached but has no snapshot",
    ]);
  });

  it("reads the node of the [tools] section only", () => {
    expect(
      miseNode('[env]\nnode = "1.0.0"\n\n[tools]\n# pinned\nnode = "22.23.4"\ngo = "1"\n'),
    ).toBe("22.23.4");
    expect(miseNode('[env]\nnode = "1.0.0"\n')).toBeUndefined();
  });
});
