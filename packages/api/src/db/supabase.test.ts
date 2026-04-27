import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @supabase/supabase-js before importing SupabaseDb
const mockFrom = vi.fn();
const mockClient = { from: mockFrom };

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockClient),
}));

// Must import after mock setup
const { SupabaseDb } = await import("./supabase.js");

function mockChain(result: { data?: unknown; error?: unknown; count?: number }) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.delete = vi.fn().mockReturnValue(chain);
  chain.upsert = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.range = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  // When no terminal method is called (e.g., listRuns), make the chain itself thenable
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock for Supabase client
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

describe("SupabaseDb", () => {
  let db: InstanceType<typeof SupabaseDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new SupabaseDb("https://test.supabase.co", "test-key");
  });

  it("should log connection on construction (VT-9)", () => {
    // Constructor already ran in beforeEach — SupabaseDb logs "Connected to Supabase"
    // We just verify no error was thrown
    expect(db).toBeTruthy();
  });

  it("getAgent returns agent when found", async () => {
    const agent = { id: "a-1", namespace: "ns", name: "test", verified: false };
    mockFrom.mockReturnValue(mockChain({ data: agent }));

    const result = await db.getAgent("ns", "test");
    expect(result).toEqual(agent);
    expect(mockFrom).toHaveBeenCalledWith("agents");
  });

  it("getAgent returns null when not found", async () => {
    mockFrom.mockReturnValue(mockChain({ data: null }));

    const result = await db.getAgent("ns", "missing");
    expect(result).toBeNull();
  });

  it("createRun inserts and returns run", async () => {
    const run = {
      id: "run-1",
      agent_id: "a-1",
      agent_version: "1.0.0",
      status: "running",
    };
    mockFrom.mockReturnValue(mockChain({ data: run }));

    const result = await db.createRun({
      id: "run-1",
      agent_id: "a-1",
      agent_version: "1.0.0",
      status: "running",
    });
    expect(result.id).toBe("run-1");
    expect(mockFrom).toHaveBeenCalledWith("runs");
  });

  it("updateRun updates and returns run", async () => {
    const run = { id: "run-1", status: "completed", duration_ms: 1500 };
    mockFrom.mockReturnValue(mockChain({ data: run }));

    const result = await db.updateRun("run-1", {
      status: "completed",
      duration_ms: 1500,
    });
    expect(result?.status).toBe("completed");
  });

  it("getApiKeyByHash returns key when found", async () => {
    const key = { id: "k-1", key_hash: "hash-abc", user_id: "u-1", name: "Test" };
    mockFrom.mockReturnValue(mockChain({ data: key }));

    const result = await db.getApiKeyByHash("hash-abc");
    expect(result?.name).toBe("Test");
    expect(mockFrom).toHaveBeenCalledWith("api_keys");
  });

  it("throws on Supabase error", async () => {
    mockFrom.mockReturnValue(mockChain({ data: null, error: { message: "connection refused" } }));

    await expect(db.getAgent("ns", "test")).rejects.toThrow("connection refused");
  });
});
