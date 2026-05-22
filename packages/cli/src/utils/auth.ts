import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".skrun");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface SkrunConfig {
  token?: string;
  username?: string;
  registry_url?: string;
}

function readConfig(): SkrunConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(config: SkrunConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  try {
    chmodSync(CONFIG_FILE, 0o600); // Owner read/write only
  } catch {
    // chmod may fail on Windows — acceptable
  }
}

export function getToken(): string | null {
  return readConfig().token ?? null;
}

/**
 * Persist a token to the local config.
 *
 * When `username` is omitted, the existing `username` is cleared. This
 * matters when switching from an OAuth-authenticated session (`sk_live_*`
 * or GitHub OAuth) to a `dev-token` session — without the clear, the
 * stale OAuth username would leak into namespace resolution and the CLI
 * would try to push under the wrong namespace.
 */
export function saveToken(token: string, username?: string): void {
  const config = readConfig();
  config.token = token;
  if (username) {
    config.username = username;
  } else {
    config.username = undefined;
  }
  writeConfig(config);
}

export function getUsername(): string | null {
  return readConfig().username ?? null;
}

export function removeToken(): void {
  const config = readConfig();
  config.token = undefined;
  writeConfig(config);
}

export function getRegistryUrl(): string {
  return process.env.SKRUN_REGISTRY_URL ?? readConfig().registry_url ?? "http://localhost:4000";
}

/**
 * Resolve the caller's registry namespace.
 *
 * The namespace is no longer carried in `agent.yaml.name` — the registry
 * derives it at push time from the caller's auth context. This helper
 * mirrors the registry's resolution rules so the CLI can construct the
 * correct push URL (`/api/agents/<namespace>/<name>/push`).
 *
 * Resolution order (token wins — cache is only consulted for tokens that
 * have no implicit namespace):
 *  1. Sentinel `dev-token` → namespace `dev` (single-tenant dev mode).
 *     Always wins over any cached `username` so users switching between
 *     OAuth and dev-token don't accidentally push under their last OAuth
 *     identity.
 *  2. Locally cached `username` (set by OAuth login or by a prior
 *     /api/me lookup). Most common case after `skrun login` via GitHub.
 *  3. Otherwise fetch `/api/me` once, cache the namespace as `username`,
 *     and return it. Covers `sk_live_*` API keys whose namespace isn't
 *     captured client-side at login time.
 *
 * Throws if no token is set or the registry can't resolve the namespace.
 */
export async function getCurrentNamespace(): Promise<string> {
  const token = getToken();
  if (!token) {
    throw new Error("Not logged in. Run `skrun login` first.");
  }

  // dev-token always maps to the `dev` namespace — override any stale cached
  // username from a prior OAuth session.
  if (token === "dev-token") {
    return "dev";
  }

  const cached = getUsername();
  if (cached) return cached;

  const registryUrl = getRegistryUrl();
  const res = await fetch(`${registryUrl}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to resolve your namespace from the registry (HTTP ${res.status}). Run \`skrun login\` again.`,
    );
  }

  const data = (await res.json()) as { namespace?: string };
  if (!data.namespace) {
    throw new Error("Registry /api/me response missing the `namespace` field.");
  }

  saveToken(token, data.namespace);
  return data.namespace;
}
