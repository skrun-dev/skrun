// Filesystem-based manifest detection for agent script dependencies.
//
// Detects standard language manifests at the bundle root and returns their
// CONTENT (no absolute paths — paths break cross-host hash determinism).
// The runtime hashes the content to drive a content-addressable cache —
// `~/.skrun/deps/<hash>/` on a server that runs scripts itself; a cloud
// sandbox runner keeps its own, for one run.
//
// Precedence:
//   - Node manifest:   package.json
//   - Node lockfile:   pnpm-lock.yaml > yarn.lock > package-lock.json
//   - Python manifest: pyproject.toml > requirements.txt
//   - Python lockfile: uv.lock > poetry.lock
//
// If both Python manifests are present, pyproject.toml wins.
// If no manifest is found, returns { ecosystem: "none" }.
//
// All detection is best-effort and side-effect-free: missing files do not
// throw — they simply produce a narrower result.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export type ManifestEcosystem = "node" | "python" | "none";

export type NodeLockfileKind = "npm" | "pnpm" | "yarn";
export type PythonLockfileKind = "uv" | "poetry";
export type PythonManifestKind = "pyproject" | "requirements";

export type ManifestInfo =
  | {
      ecosystem: "node";
      manifestContent: string;
      lockfileKind?: NodeLockfileKind;
      lockfileContent?: string;
    }
  | {
      ecosystem: "python";
      manifestKind: PythonManifestKind;
      manifestContent: string;
      lockfileKind?: PythonLockfileKind;
      lockfileContent?: string;
      pythonProjectName?: string;
    }
  | { ecosystem: "none" };

interface NodeLockfileMatch {
  kind: NodeLockfileKind;
  filename: string;
}

// Lockfile precedence: pnpm > yarn > npm.
const NODE_LOCKFILES: readonly NodeLockfileMatch[] = [
  { kind: "pnpm", filename: "pnpm-lock.yaml" },
  { kind: "yarn", filename: "yarn.lock" },
  { kind: "npm", filename: "package-lock.json" },
];

interface PythonLockfileMatch {
  kind: PythonLockfileKind;
  filename: string;
}

// Lockfile precedence: uv > poetry.
const PYTHON_LOCKFILES: readonly PythonLockfileMatch[] = [
  { kind: "uv", filename: "uv.lock" },
  { kind: "poetry", filename: "poetry.lock" },
];

function readFileIfExists(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

function findFirstExisting<T extends { filename: string }>(
  bundleRoot: string,
  candidates: readonly T[],
): { match: T; content: string } | undefined {
  for (const candidate of candidates) {
    const content = readFileIfExists(join(bundleRoot, candidate.filename));
    if (content !== undefined) {
      return { match: candidate, content };
    }
  }
  return undefined;
}

// Best-effort extraction of `[project] name = "..."` from a pyproject.toml
// content. Only the project name is needed downstream (for non-editable pip
// install identification). Falls back to undefined on any parse failure.
function extractPyprojectName(pyprojectContent: string): string | undefined {
  const projectSectionMatch = pyprojectContent.match(/^\s*\[project\]\s*$/m);
  if (!projectSectionMatch || projectSectionMatch.index === undefined) return undefined;
  const after = pyprojectContent.slice(projectSectionMatch.index + projectSectionMatch[0].length);
  // Stop at the next section header.
  const nextSectionIdx = after.search(/^\s*\[[^\]]+\]\s*$/m);
  const projectBlock = nextSectionIdx === -1 ? after : after.slice(0, nextSectionIdx);
  const nameMatch = projectBlock.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  return nameMatch?.[1];
}

/**
 * Detect a script-dependency manifest at the bundle root.
 *
 * Pure function except for filesystem reads. Never throws on missing files.
 *
 * @param bundleRoot Absolute path to the bundle root directory.
 * @returns A discriminated union describing the manifest content (or `none`).
 */
export function detectManifest(bundleRoot: string): ManifestInfo {
  // Node detection — package.json is the entry signal.
  const nodeManifest = readFileIfExists(join(bundleRoot, "package.json"));
  if (nodeManifest !== undefined) {
    const lockfile = findFirstExisting(bundleRoot, NODE_LOCKFILES);
    return {
      ecosystem: "node",
      manifestContent: nodeManifest,
      ...(lockfile && {
        lockfileKind: lockfile.match.kind,
        lockfileContent: lockfile.content,
      }),
    };
  }

  // Python detection — pyproject.toml wins over requirements.txt when both
  // are present.
  const pyproject = readFileIfExists(join(bundleRoot, "pyproject.toml"));
  if (pyproject !== undefined) {
    const lockfile = findFirstExisting(bundleRoot, PYTHON_LOCKFILES);
    const projectName = extractPyprojectName(pyproject);
    return {
      ecosystem: "python",
      manifestKind: "pyproject",
      manifestContent: pyproject,
      ...(lockfile && {
        lockfileKind: lockfile.match.kind,
        lockfileContent: lockfile.content,
      }),
      ...(projectName && { pythonProjectName: projectName }),
    };
  }

  const requirements = readFileIfExists(join(bundleRoot, "requirements.txt"));
  if (requirements !== undefined) {
    // requirements.txt does not have an associated lockfile in this design
    // (pinned versions in requirements.txt itself act as the lock).
    return {
      ecosystem: "python",
      manifestKind: "requirements",
      manifestContent: requirements,
    };
  }

  return { ecosystem: "none" };
}

// Best-effort stdlib sets used to flag scripts that import third-party
// packages without declaring them. Coverage is intentionally generous to
// MINIMIZE FALSE POSITIVES (warning when no manifest is needed) over false
// negatives (missing a warning when one is needed). The `[NEEDS
// CLARIFICATION]` cost of a missed warning is "build succeeds, runtime fails
// later"; the cost of a false positive is "noisy build output". Tilt toward
// silence.

// Python standard library top-level module names: `sys.stdlib_module_names`
// of CPython 3.12 (3.12.10), whole and verbatim — private modules included, as
// an import of one is no third-party dependency either. Regenerate with:
//   python3.12 -c "import sys; print(' '.join(sorted(sys.stdlib_module_names)))"
// A hand-picked subset missed common modules (`__future__`, `codecs`,
// `optparse`, `graphlib`) and warned on scripts that needed no manifest.
const PYTHON_3_12_STDLIB = `
  __future__ _abc _aix_support _ast _asyncio _bisect _blake2 _bz2 _codecs _codecs_cn _codecs_hk
  _codecs_iso2022 _codecs_jp _codecs_kr _codecs_tw _collections _collections_abc _compat_pickle
  _compression _contextvars _crypt _csv _ctypes _curses _curses_panel _datetime _dbm _decimal
  _elementtree _frozen_importlib _frozen_importlib_external _functools _gdbm _hashlib _heapq
  _imp _io _json _locale _lsprof _lzma _markupbase _md5 _msi _multibytecodec _multiprocessing
  _opcode _operator _osx_support _overlapped _pickle _posixshmem _posixsubprocess _py_abc
  _pydatetime _pydecimal _pyio _pylong _queue _random _scproxy _sha1 _sha2 _sha3 _signal
  _sitebuiltins _socket _sqlite3 _sre _ssl _stat _statistics _string _strptime _struct _symtable
  _thread _threading_local _tkinter _tokenize _tracemalloc _typing _uuid _warnings _weakref
  _weakrefset _winapi _wmi _zoneinfo abc aifc antigravity argparse array ast asyncio atexit
  audioop base64 bdb binascii bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd
  code codecs codeop collections colorsys compileall concurrent configparser contextlib
  contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis
  doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch
  fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip
  hashlib heapq hmac html http idlelib imaplib imghdr importlib inspect io ipaddress itertools
  json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap
  modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath nturl2path numbers
  opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform
  plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc
  pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched
  secrets select selectors shelve shlex shutil signal site smtplib sndhdr socket socketserver
  spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct
  subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios
  textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc
  tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave
  weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib
  zoneinfo
`;

// Two names that list lacks and the runtime image's Python 3.12 still imports
// without a package from the index: `distutils`, removed from the standard
// library in 3.12 but provided there by setuptools, a system package pip
// depends on; and `test`, the regression-test package, which the standard
// library ships and `sys.stdlib_module_names` leaves out. The other modules
// 3.12 removed (`asynchat`, `asyncore`, `imp`, `smtpd`) import nowhere without
// a package, so a script importing one draws the warning.
const PYTHON_STDLIB_BEYOND_3_12 = ["distutils", "test"];

const PYTHON_STDLIB = new Set<string>([
  ...PYTHON_3_12_STDLIB.split(/\s+/).filter(Boolean),
  ...PYTHON_STDLIB_BEYOND_3_12,
]);

// Node.js built-in module names (Node 20+). Both bare (`fs`) and prefixed
// (`node:fs`) forms are accepted by the import scanner via prefix-stripping.
const NODE_STDLIB = new Set<string>([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "test",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

const PYTHON_IMPORT_RE = /^[ \t]*(?:import|from)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm;
// Matches `require('pkg')`, `require("pkg")`, `import 'pkg'`, `import "pkg"`,
// `import x from 'pkg'`, etc. Captures the package specifier head.
const NODE_IMPORT_RE = /(?:require\s*\(\s*|import\s+(?:[^"'\n]*\s+from\s+)?)["']([^"'\n]+)["']/g;

function rootPackageOf(spec: string, ecosystem: "node" | "python"): string {
  let s = spec;
  if (ecosystem === "node") {
    if (s.startsWith("node:")) s = s.slice(5);
    // Skip relative imports — these target the bundle itself, not deps.
    if (s.startsWith(".") || s.startsWith("/")) return "";
    // Scoped npm package: keep `@scope/name` as a single unit, but match
    // stdlib only on first segment for non-scoped.
    if (s.startsWith("@")) {
      const slash = s.indexOf("/");
      return slash === -1 ? s : s.slice(0, slash + 1) + s.slice(slash + 1).split("/")[0];
    }
    return s.split("/")[0];
  }
  // Python: top-level package only.
  return s.split(".")[0];
}

function listPythonScripts(scriptsDir: string): string[] {
  if (!existsSync(scriptsDir) || !statSync(scriptsDir).isDirectory()) return [];
  return readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".py")
    .map((entry) => join(scriptsDir, entry.name));
}

function listNodeScripts(scriptsDir: string): string[] {
  if (!existsSync(scriptsDir) || !statSync(scriptsDir).isDirectory()) return [];
  return readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false;
      const ext = extname(entry.name);
      return ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts";
    })
    .map((entry) => join(scriptsDir, entry.name));
}

/**
 * Best-effort scan of a `scripts/` directory to detect imports of packages
 * outside the language's standard library. Used to warn agent authors when
 * `scripts/` is non-empty and non-trivial but no manifest declares the
 * dependencies.
 *
 * Returns false on any I/O error or if the directory does not exist.
 *
 * @param scriptsDir Absolute path to the bundle's `scripts/` directory.
 * @param ecosystem  Which language's stdlib to compare imports against.
 */
export function hasNonStdlibImports(scriptsDir: string, ecosystem: "node" | "python"): boolean {
  const scripts =
    ecosystem === "python" ? listPythonScripts(scriptsDir) : listNodeScripts(scriptsDir);
  if (scripts.length === 0) return false;

  const stdlib = ecosystem === "python" ? PYTHON_STDLIB : NODE_STDLIB;
  const importRe = ecosystem === "python" ? PYTHON_IMPORT_RE : NODE_IMPORT_RE;

  for (const scriptPath of scripts) {
    let content: string;
    try {
      content = readFileSync(scriptPath, "utf-8");
    } catch {
      continue;
    }

    importRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((match = importRe.exec(content)) !== null) {
      const root = rootPackageOf(match[1] ?? "", ecosystem);
      if (!root) continue;
      // For Node scoped packages, stdlib check on the bare segment is enough
      // since no Node stdlib uses `@scope/...` syntax.
      const stdlibKey = ecosystem === "node" && root.startsWith("@") ? root : root;
      if (!stdlib.has(stdlibKey)) {
        return true;
      }
    }
  }

  return false;
}
