#!/usr/bin/env node
//
// check-installed-versions.mjs — does an install directory of the image hold
// exactly what its package-lock.json declares?
//
// Run it inside the image, against one of its install directories:
//   node check-installed-versions.mjs /opt/skrun-runner [--expect <name>=<version> ...]
// The file does not have to be in the image — pipe it in:
//   docker run --rm -i --entrypoint node <image> --input-type=module - \
//     /opt/skrun-runner < infra/runtime-image/check-installed-versions.mjs
//
// Exit 1, one line per problem, when:
//   - a package under node_modules/ carries another version than the lock
//     declares for that path, or is another package;
//   - a package is installed that the lock does not list. The @skrun-dev
//     packages are the exception: the image extracts them from tarballs, at
//     node_modules/@skrun-dev/<name> and nowhere else;
//   - a package the lock lists is missing (optional and dev entries excepted:
//     a platform may skip the first, an install may omit the second);
//   - the lock lists a @skrun-dev package (they never come from a registry);
//   - no @skrun-dev package is installed at all;
//   - a @skrun-dev package depends on another at a version other than the one
//     installed, or on one that is not installed;
//   - --expect names a version the installed package does not carry (the
//     version of the tarball the build was given).
// Exit 2 when the directory has no readable lock, or on a usage error.
//
// --self-test judges a few witness trees built in a temporary directory, with
// neither Docker nor an image, and exits 1 if one is judged wrongly.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SKRUN_SCOPE = "@skrun-dev/";

// A few packages publish a `v`-prefixed version field; npm records it cleaned
// in the lock. Compare the cleaned forms.
function clean(version) {
  return String(version ?? "")
    .trim()
    .replace(/^[=v]+/, "");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function nameFromPath(path) {
  return path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
}

// Every directory under node_modules/ (nested ones included) that holds a
// package.json, keyed the way package-lock.json keys its entries.
function installedPackages(root) {
  const found = new Map();
  const subdirs = (rel) => {
    try {
      return readdirSync(join(root, rel), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  const visitPackage = (rel) => {
    const manifest = readJson(join(root, rel, "package.json"));
    if (!manifest) return;
    found.set(rel, { name: manifest.name, version: manifest.version, manifest });
    visitModules(`${rel}/node_modules`);
  };
  const visitModules = (rel) => {
    for (const name of subdirs(rel)) {
      if (name.startsWith("@")) {
        for (const scoped of subdirs(`${rel}/${name}`)) visitPackage(`${rel}/${name}/${scoped}`);
      } else {
        visitPackage(`${rel}/${name}`);
      }
    }
  };
  visitModules("node_modules");
  return found;
}

function checkInstall(root, expect = new Map()) {
  const lock = readJson(join(root, "package-lock.json"));
  if (!lock || typeof lock.packages !== "object") {
    throw new Error(
      `no readable package-lock.json with a "packages" section in ${root} — an image built before its installs were locked has none`,
    );
  }
  const problems = [];
  const installed = installedPackages(root);

  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "" || entry.link) continue;
    const name = entry.name ?? nameFromPath(path);
    if (name.startsWith(SKRUN_SCOPE)) {
      problems.push(`${path}: the lock lists ${name}, which only ever comes from its tarball`);
      continue;
    }
    const found = installed.get(path);
    if (!found) {
      if (!entry.optional && !entry.dev) {
        problems.push(`${path}: the lock declares ${name}@${entry.version}, nothing is installed`);
      }
      continue;
    }
    if (found.name !== name) {
      problems.push(`${path}: installed ${found.name}, the lock declares ${name}`);
    }
    if (clean(found.version) !== clean(entry.version)) {
      problems.push(
        `${path}: installed ${name}@${found.version}, the lock declares ${entry.version}`,
      );
    }
  }

  const skrun = [];
  for (const [path, found] of installed) {
    if (lock.packages[path]) continue;
    if (path === `node_modules/${found.name}` && String(found.name).startsWith(SKRUN_SCOPE)) {
      skrun.push(found);
    } else if (String(found.name).startsWith(SKRUN_SCOPE)) {
      problems.push(`${path}: a second copy of ${found.name}, besides node_modules/${found.name}`);
    } else {
      problems.push(
        `${path}: ${found.name}@${found.version} is installed, the lock does not list it`,
      );
    }
  }

  // Every install directory of the image runs @skrun-dev code: one without any
  // is not an image this checks, and a run without --expect would otherwise
  // pass it.
  if (skrun.length === 0) {
    problems.push(
      `no @skrun-dev package is installed under ${root}/node_modules/@skrun-dev — the image extracts at least one there`,
    );
  }

  for (const pkg of skrun) {
    for (const [dep, spec] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (!dep.startsWith(SKRUN_SCOPE)) continue;
      const other = installed.get(`node_modules/${dep}`);
      if (!other) {
        problems.push(`${pkg.name} depends on ${dep}@${spec}, which is not installed`);
      } else if (clean(spec) !== clean(other.version)) {
        problems.push(`${pkg.name} depends on ${dep}@${spec}, installed ${other.version}`);
      }
    }
  }

  for (const [name, version] of expect) {
    const found = installed.get(`node_modules/${name}`);
    if (!found) {
      problems.push(`node_modules/${name}: expected ${version}, nothing is installed`);
    } else if (clean(found.version) !== clean(version)) {
      problems.push(`node_modules/${name}: installed ${found.version}, expected ${version}`);
    }
  }

  return { problems, installed: installed.size, skrun };
}

// ---------- self-test ----------

function writeTree(root, lockPackages, installed) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({ name: "witness", lockfileVersion: 3, packages: lockPackages }),
  );
  for (const [path, manifest] of Object.entries(installed)) {
    const file = join(root, path, "package.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(manifest));
  }
}

function selfTest() {
  const base = {
    "": { name: "witness", version: "0.0.0" },
    "node_modules/a": { version: "1.0.0" },
    "node_modules/@s/b": { version: "2.0.0" },
    "node_modules/a/node_modules/c": { version: "3.0.0" },
    "node_modules/v-prefixed": { version: "4.0.0" },
    "node_modules/opt": { version: "5.0.0", optional: true },
  };
  const tree = {
    "node_modules/a": { name: "a", version: "1.0.0" },
    "node_modules/@s/b": { name: "@s/b", version: "2.0.0" },
    "node_modules/a/node_modules/c": { name: "c", version: "3.0.0" },
    "node_modules/v-prefixed": { name: "v-prefixed", version: "v4.0.0" },
    "node_modules/@skrun-dev/schema": { name: "@skrun-dev/schema", version: "9.9.9" },
    "node_modules/@skrun-dev/runtime": {
      name: "@skrun-dev/runtime",
      version: "9.9.9",
      dependencies: { "@skrun-dev/schema": "9.9.9", a: "^1.0.0" },
    },
  };
  const cases = [
    { name: "a tree that matches its lock", lock: base, tree, problems: 0 },
    {
      name: "one installed version differs from the lock",
      lock: base,
      tree: { ...tree, "node_modules/a/node_modules/c": { name: "c", version: "3.0.1" } },
      problems: 1,
    },
    {
      name: "a package the lock does not list",
      lock: base,
      tree: { ...tree, "node_modules/extra": { name: "extra", version: "1.0.0" } },
      problems: 1,
    },
    {
      name: "a package the lock lists is missing",
      lock: { ...base, "node_modules/gone": { version: "1.0.0" } },
      tree,
      problems: 1,
    },
    {
      name: "the lock lists a @skrun-dev package",
      lock: { ...base, "node_modules/@skrun-dev/schema": { version: "9.9.9" } },
      tree,
      problems: 1,
    },
    {
      name: "a second, nested copy of a @skrun-dev package",
      lock: base,
      tree: {
        ...tree,
        "node_modules/a/node_modules/@skrun-dev/schema": {
          name: "@skrun-dev/schema",
          version: "9.9.8",
        },
      },
      problems: 1,
    },
    {
      name: "a @skrun-dev package depends on another at a version not installed",
      lock: base,
      tree: {
        ...tree,
        "node_modules/@skrun-dev/schema": { name: "@skrun-dev/schema", version: "9.9.8" },
      },
      problems: 1,
    },
    {
      name: "--expect names a version the tarball does not carry",
      lock: base,
      tree,
      expect: new Map([["@skrun-dev/runtime", "9.9.8"]]),
      problems: 1,
    },
    {
      name: "no @skrun-dev package at all, and no --expect",
      lock: base,
      tree: Object.fromEntries(
        Object.entries(tree).filter(([path]) => !path.includes("@skrun-dev/")),
      ),
      problems: 1,
    },
  ];

  const scratch = mkdtempSync(join(tmpdir(), "check-installed-versions-"));
  let wrong = 0;
  try {
    cases.forEach((c, i) => {
      const root = join(scratch, String(i));
      writeTree(root, c.lock, c.tree);
      const { problems } = checkInstall(root, c.expect);
      if (problems.length === c.problems) {
        console.log(`witness: ${c.name} → ${problems.length} problem(s), as expected`);
      } else {
        wrong++;
        console.log(`WRONG: ${c.name} → ${problems.length} problem(s), expected ${c.problems}`);
        for (const p of problems) console.log(`    ${p}`);
      }
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(
    `check-installed-versions: self-test, ${cases.length} witnesses, ${wrong} judged wrongly`,
  );
  return wrong === 0 ? 0 : 1;
}

// ---------- command line ----------

function main(args) {
  if (args[0] === "--self-test") return selfTest();
  let root = null;
  const expect = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--expect") {
      const pair = args[++i] ?? "";
      const at = pair.lastIndexOf("=");
      if (at <= 0) {
        console.error(`check-installed-versions: --expect takes <name>=<version>, got '${pair}'`);
        return 2;
      }
      expect.set(pair.slice(0, at), pair.slice(at + 1));
    } else if (root === null) {
      root = args[i];
    } else {
      console.error(`check-installed-versions: unexpected argument '${args[i]}'`);
      return 2;
    }
  }
  if (root === null) {
    console.error(
      "usage: check-installed-versions.mjs <install dir> [--expect <name>=<version> ...]",
    );
    console.error("       check-installed-versions.mjs --self-test");
    return 2;
  }
  let result;
  try {
    result = checkInstall(root, expect);
  } catch (err) {
    console.error(`check-installed-versions: ${err.message}`);
    return 2;
  }
  if (result.problems.length > 0) {
    for (const p of result.problems) console.log(`FAIL: ${p}`);
    console.log(
      `check-installed-versions: ${result.problems.length} problem(s) under ${root} — the install differs from its package-lock.json`,
    );
    return 1;
  }
  const skrun = result.skrun.map((p) => `${p.name}@${p.version}`).join(", ") || "none";
  console.log(
    `check-installed-versions: ${root} — ${result.installed} packages, each at the version its lock declares; extracted: ${skrun}`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
