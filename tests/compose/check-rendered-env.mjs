// Checks a configuration rendered by tests/compose/quickstart-render.sh.
//
//   node tests/compose/check-rendered-env.mjs --overrides <full|minimal> <rendered.json>
//   node tests/compose/check-rendered-env.mjs --boot <rendered.json>
//
// --overrides: what reaches the api service when infra/.env carries the probe
//   lines (quickstart-render.sh --probe). A name the operator decides arrives;
//   a name the stack decides keeps the stack's value whatever the file says. The
//   caller names the render, and the services present must agree with that name:
//   a minimal render with the full stack's services, or the reverse, is an error.
// --boot: the api's start-up checks run on the environment the quick start gives
//   the api service (a full render without the probe lines): a child process
//   whose environment is exactly that one, plus PATH, imports the built api
//   (packages/api/dist — run `pnpm build` first) and builds the app on in-memory
//   storage and database. Nothing is listened on, and no container is started.
//   A child that cannot read the render exits with a code of its own, and the
//   run fails saying so: the api was never imported, so it is not blamed.
//   Before importing the api, the child checks that it inherited nothing from
//   the calling process: it reads the same render and compares the NAMES of its
//   own environment with the api's names plus PATH; a name in excess or a name
//   missing fails the run, and the message names them, never a value. Under
//   Windows, Node adds a fixed set of names to a child's environment by itself,
//   with the calling process's values (PLATFORM_ADDED below): there, those names
//   are tolerated when the render does not carry them, and names compare
//   regardless of case, as Windows reads them. Elsewhere the comparison is exact.
//
// The rendered environment carries generated credentials: this script prints the
// names it checks and the values that are not secret, never the environment
// itself, and names a render it cannot read by its path, never quoting it.
// --boot prints the child's error output only.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The probe lines of quickstart-render.sh --probe that this script asserts. */
const PROBE_CLIENT_ID = "probe-client-id-from-infra-env";
const PROBE_TAG = "0.0.0-probe";

/** The services the minimal overlay removes, and the full stack runs. */
const BACKING = ["postgres", "minio", "redis", "preflight"];

/** What the child prints once the app is built, on its standard output. */
const STARTED = "the api started on this environment";

/** The child's exit code when its environment is not exactly the rendered one. */
const ENV_MISMATCH = 3;

/** The child's exit code when it cannot read the render it was given: the api is not imported. */
const RENDER_UNREADABLE = 4;

/**
 * The names Node adds by itself, under Windows, to the environment of a child
 * spawned with an explicit `env` — each one the calling process has and the
 * given environment lacks, with the calling process's value. They cannot be
 * kept out, so the child tolerates them there, and only there.
 */
const PLATFORM_ADDED =
  process.platform === "win32"
    ? [
        "HOMEDRIVE",
        "HOMEPATH",
        "LOGONSERVER",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERDOMAIN",
        "USERNAME",
        "USERPROFILE",
        "WINDIR",
      ]
    : [];

/** A name as the platform compares it: Windows ignores case, elsewhere it counts. */
const nameKey = (name) => (process.platform === "win32" ? name.toUpperCase() : name);

const usage = () => {
  console.error(
    "usage: node tests/compose/check-rendered-env.mjs --overrides <full|minimal> <rendered.json>\n" +
      "       node tests/compose/check-rendered-env.mjs --boot <rendered.json>",
  );
  process.exit(2);
};

/**
 * The render at `path`: its configuration, its api service, and that service's
 * environment. The render carries generated credentials, so no error leaves
 * here with its text: a render that does not parse is said so by its path
 * alone — the parser's message quotes the file, and Node prints the offending
 * line of the file when such an error goes uncaught. Each caller catches what
 * this throws and prints its message.
 */
const readRender = (path) => {
  const text = readFileSync(path, "utf8");
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const api = config?.services?.api;
  if (!api) throw new Error(`${path}: no api service in the rendered configuration`);
  return { config, api, env: api.environment ?? {} };
};

/** In the parent: a render it cannot read fails the run, with no stack. */
const readRenderOrFail = (path) => {
  try {
    return readRender(path);
  } catch (err) {
    console.error(`FAIL — the render cannot be read: ${err.message}`);
    process.exit(1);
  }
};

/**
 * `postgres://user:secret@host` → `postgres://user:***@host`: a URL fit to print.
 * An empty password stays visible as such (`user:@host`).
 */
const masked = (url) => String(url).replace(/\/\/([^:/@]*):[^@]+@/, "//$1:***@");

function checkOverrides(mode, path) {
  const { config, api, env } = readRenderOrFail(path);
  const failures = [];
  const expect = (ok, message) => {
    if (!ok) failures.push(message);
  };
  const equals = (name, wanted) =>
    expect(
      env[name] === wanted,
      `${name} is ${JSON.stringify(env[name])}, expected ${JSON.stringify(wanted)}`,
    );

  // The render is the one the caller names.
  const present = BACKING.filter((service) => config.services?.[service] !== undefined);
  if (mode === "full") {
    expect(
      present.length === BACKING.length,
      `a full render runs ${BACKING.join(", ")}; this one runs ${present.join(", ") || "none of them"}`,
    );
  } else {
    expect(
      present.length === 0,
      `a minimal render runs none of ${BACKING.join(", ")}; this one runs ${present.join(", ")}`,
    );
  }

  // Decided by the operator, in infra/.env: it arrives.
  equals("GITHUB_CLIENT_ID", PROBE_CLIENT_ID);
  expect(
    typeof env.CORS_ORIGIN === "string" && env.CORS_ORIGIN !== "",
    "CORS_ORIGIN is empty: the api refuses to start in production without it",
  );
  // The webhook key the quick start generates (64 hexadecimal characters): its
  // absence refuses no start — webhooks would only be refused when sent — so
  // the boot check cannot see it. Said present or not, never printed.
  const webhookKey = env.WEBHOOK_SIGNING_KEY;
  expect(
    typeof webhookKey === "string" && /^[0-9a-f]{64}$/.test(webhookKey),
    `WEBHOOK_SIGNING_KEY ${typeof webhookKey === "string" && webhookKey !== "" ? "reaches the api, but not as 64 hexadecimal characters" : "does not reach the api"}: the quick start generates it`,
  );

  // Decided by the stack: its value, whatever infra/.env says.
  equals("NODE_ENV", "production");
  equals("SKRUN_RUNTIME", "local");
  equals("SKRUN_TRUST_PROXY_HEADER", "");
  equals("SKRUN_AGENTS_DIR", "");
  equals("RUNTIME_IMAGE_TAG", "");
  expect(
    typeof api.image === "string" && api.image.endsWith(`:${PROBE_TAG}`),
    `the api image is ${JSON.stringify(api.image)}: the tag of infra/.env (${PROBE_TAG}) picks it`,
  );

  // No provider key comes from the template: every one of them is commented out.
  for (const [name, value] of Object.entries(env)) {
    if (name.endsWith("_API_KEY")) {
      expect(value === "" || value === null, `${name} reaches the api with a value`);
    }
  }

  if (mode === "full") {
    const password = config.services?.postgres?.environment?.POSTGRES_PASSWORD;
    expect(
      typeof password === "string" && password !== "",
      "the postgres service has no POSTGRES_PASSWORD, or an empty one",
    );
    expect(
      typeof password === "string" &&
        env.DATABASE_URL === `postgres://skrun:${password}@postgres:5432/skrun`,
      `DATABASE_URL is ${JSON.stringify(masked(env.DATABASE_URL))}, expected the stack's own postgres://skrun:<the postgres password>@postgres:5432/skrun`,
    );
    equals("S3_ENDPOINT", "http://minio:9000");
    expect(
      typeof env.S3_ACCESS_KEY_ID === "string" && env.S3_ACCESS_KEY_ID !== "",
      "S3_ACCESS_KEY_ID is empty",
    );
    const preflight = config.services?.preflight?.environment?.POSTGRES_PASSWORD;
    expect(
      typeof preflight === "string" && preflight !== "",
      "the preflight service has no POSTGRES_PASSWORD, or an empty one",
    );
  } else {
    // The overlay's own empty values win over infra/.env and over the probe.
    for (const name of [
      "DATABASE_URL",
      "S3_ENDPOINT",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_BUCKET",
    ]) {
      expect(env[name] === "", `${name} is not empty: the minimal overlay sets it to ""`);
    }
  }

  if (failures.length > 0) {
    console.error(`FAIL — ${mode} render, ${path}:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    `OK — ${mode} render: what the operator decides arrives from infra/.env, what the stack decides keeps the stack's value.`,
  );
}

function checkBoot(path) {
  const { env } = readRenderOrFail(path);
  const apiDir = fileURLToPath(new URL("../../packages/api/", import.meta.url));
  const entry = new URL("../../packages/api/dist/index.js", import.meta.url);
  if (!existsSync(fileURLToPath(entry))) {
    console.error(`FAIL — ${fileURLToPath(entry)} is missing: run pnpm build first`);
    process.exit(1);
  }
  const childEnv = {};
  for (const [name, value] of Object.entries(env)) childEnv[name] = value ?? "";
  childEnv.PATH = process.env.PATH ?? "";
  const child = spawnSync(
    process.execPath,
    // The render's path, absolute: the child reads the names it must have from it.
    [fileURLToPath(import.meta.url), "--boot-child", entry.href, resolve(path)],
    // The api's own directory, as the bare-metal install runs it: its relative
    // defaults (the dashboard's ../web/dist) resolve as they would there.
    { cwd: apiDir, env: childEnv, encoding: "utf8", timeout: 60_000 },
  );
  const stderr = (child.stderr ?? "").trim();
  if (stderr) console.error(`--- the boot child's error output ---\n${stderr}\n---`);
  if (child.status === RENDER_UNREADABLE) {
    console.error("FAIL — the boot child could not read the render: the api was not started");
    process.exit(1);
  }
  if (child.status === ENV_MISMATCH) {
    console.error(
      "FAIL — the child's environment is not exactly the rendered one: the api was not started",
    );
    process.exit(1);
  }
  const started = (child.stdout ?? "").split(/\r?\n/).includes(STARTED);
  if (child.error || child.status !== 0 || !started) {
    const why = child.error
      ? child.error.message
      : `exit ${child.status}${child.signal ? `, signal ${child.signal}` : ""}`;
    console.error(`FAIL — the api refused to start on the rendered environment (${why})`);
    process.exit(1);
  }
  console.log("OK — the api starts on the environment the quick start gives it.");
}

/**
 * In the child, before the api is imported: its environment holds exactly the
 * api's names of the render (`env`) plus PATH — nothing inherited from the
 * caller. Prints names only.
 */
function checkInheritedNothing(env) {
  const wanted = [...Object.keys(env), "PATH"];
  const wantedKeys = new Set(wanted.map(nameKey));
  const tolerated = new Set(PLATFORM_ADDED.filter((name) => !wantedKeys.has(name)));
  const seen = Object.keys(process.env);
  const seenKeys = new Set(seen.map(nameKey));
  const excess = seen.filter(
    (name) => !wantedKeys.has(nameKey(name)) && !tolerated.has(nameKey(name)),
  );
  const missing = wanted.filter((name) => !seenKeys.has(nameKey(name)));
  if (excess.length === 0 && missing.length === 0) return;
  console.error("the boot child's environment is not the api's rendered one plus PATH:");
  if (excess.length > 0) {
    console.error(
      `  ${excess.length} name(s) not in the render, inherited from the calling process: ${excess.sort().join(", ")}`,
    );
  }
  if (missing.length > 0) {
    console.error(
      `  ${missing.length} name(s) of the render missing: ${missing.sort().join(", ")}`,
    );
  }
  process.exit(ENV_MISMATCH);
}

async function bootChild(href, path) {
  // The render first, before anything of the api is loaded: a child that
  // cannot read it says so and exits with its own code.
  let env;
  try {
    ({ env } = readRender(path));
  } catch (err) {
    console.error(`the boot child could not read the render: ${err.message}`);
    process.exit(RENDER_UNREADABLE);
  }
  checkInheritedNothing(env);
  const { createApp, MemoryDb, MemoryStorage } = await import(href);
  createApp(new MemoryStorage(), new MemoryDb());
  console.log(STARTED);
  process.exit(0);
}

const [flag, ...rest] = process.argv.slice(2);
if (flag === "--overrides") {
  const [mode, path] = rest;
  if ((mode !== "full" && mode !== "minimal") || !path || rest.length !== 2) usage();
  checkOverrides(mode, path);
} else if (flag === "--boot") {
  if (rest.length !== 1) usage();
  checkBoot(rest[0]);
} else if (flag === "--boot-child") {
  await bootChild(rest[0], rest[1]);
} else {
  usage();
}
