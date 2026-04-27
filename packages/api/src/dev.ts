import { serve } from "@hono/node-server";
import { isOAuthConfigured } from "./auth/github-oauth.js";
import type { DbAdapter } from "./db/adapter.js";
import { createApp } from "./index.js";
import type { StorageAdapter } from "./storage/adapter.js";
import { LocalStorage } from "./storage/local.js";
import { MemoryStorage } from "./storage/memory.js";

let db: DbAdapter;
let storage: StorageAdapter;

if (process.env.DATABASE_URL) {
  const { SupabaseDb } = await import("./db/supabase.js");
  db = new SupabaseDb(process.env.DATABASE_URL, process.env.SUPABASE_KEY ?? "");
  storage = new MemoryStorage();
  console.log("  Storage: Supabase + memory bundles");
} else {
  const { SqliteDb } = await import("./db/sqlite.js");
  db = new SqliteDb();
  storage = new LocalStorage(".skrun/bundles");
  console.log("  Storage: SQLite (skrun.db) + local bundles (.skrun/bundles/)");
}

const app = createApp(storage, db);
const port = Number(process.env.PORT ?? 4000);

serve({ fetch: app.fetch, port }, () => {
  console.log(`✓ Skrun Registry API running at http://localhost:${port}`);
  console.log("  GET  /health — Health check");
  console.log("  POST /api/agents/:ns/:name/push — Push agent bundle");
  console.log("  GET  /api/agents/:ns/:name/pull — Pull agent bundle");
  console.log("  GET  /api/agents — List agents");
  if (isOAuthConfigured()) {
    console.log("  Auth: GitHub OAuth + API keys (sk_live_*)");
    console.log("  Login: http://localhost:%d/login", port);
  } else {
    console.log("  Auth: Bearer dev-token (namespace: dev)");
  }
});
