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

export function saveToken(token: string, username?: string): void {
  const config = readConfig();
  config.token = token;
  if (username) config.username = username;
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
