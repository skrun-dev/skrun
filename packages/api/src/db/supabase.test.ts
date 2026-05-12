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
  chain.gte = vi.fn().mockReturnValue(chain);
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

  // VT-3 (#77): deleteVersion happy path — supabase impl
  it("deleteVersion issues delete + 2× eq on agent_versions", async () => {
    const chain = mockChain({ error: null });
    mockFrom.mockReturnValue(chain);

    await db.deleteVersion("agent-id-X", "1.0.0");

    expect(mockFrom).toHaveBeenCalledWith("agent_versions");
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith("agent_id", "agent-id-X");
    expect(chain.eq).toHaveBeenCalledWith("version", "1.0.0");
  });

  it("deleteVersion throws on Supabase error", async () => {
    mockFrom.mockReturnValue(mockChain({ error: { message: "constraint violation" } }));

    await expect(db.deleteVersion("agent-id-X", "1.0.0")).rejects.toThrow("constraint violation");
  });

  // ── Cache cost-savings ([005-cache-cost-savings-dashboard]) ──────────

  describe("cache cost-savings", () => {
    it("RT-5 supabase: updateRun passes 3 cache fields through to PostgREST", async () => {
      const run = {
        id: "r-rt-supa",
        status: "completed",
        usage_cache_read_tokens: 7143,
        usage_cache_write_tokens: 0,
        usage_cache_savings_usd: 0.000964,
      };
      const chain = mockChain({ data: run });
      mockFrom.mockReturnValue(chain);

      const result = await db.updateRun("r-rt-supa", {
        status: "completed",
        usage_cache_read_tokens: 7143,
        usage_cache_write_tokens: 0,
        usage_cache_savings_usd: 0.000964,
      });
      expect(result?.usage_cache_read_tokens).toBe(7143);
      expect(result?.usage_cache_savings_usd).toBeCloseTo(0.000964, 6);
      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          usage_cache_read_tokens: 7143,
          usage_cache_write_tokens: 0,
          usage_cache_savings_usd: 0.000964,
        }),
      );
    });

    it("VT-7 supabase: getStats({ userId }) issues .eq('user_id', ...) on runs query", async () => {
      // First mockFrom call → agents (count: exact, head)
      // Second mockFrom call → runs (with .eq("user_id", ...))
      const agentsChain = mockChain({ count: 0 });
      const runsChain = mockChain({ data: [] });
      // supabase.ts builds the runs query FIRST (outside Promise.all), then
      // calls from("agents") inside Promise.all — so mockFrom call order is
      // runs → agents.
      mockFrom.mockReturnValueOnce(runsChain).mockReturnValueOnce(agentsChain);

      await db.getStats({ userId: "user-A" });

      // Verify the runs query had .eq("user_id", "user-A")
      expect(runsChain.eq).toHaveBeenCalledWith("user_id", "user-A");
    });

    it("getStats() without userId — no .eq('user_id', ...) call on runs query", async () => {
      const agentsChain = mockChain({ count: 0 });
      const runsChain = mockChain({ data: [] });
      // supabase.ts builds the runs query FIRST (outside Promise.all), then
      // calls from("agents") inside Promise.all — so mockFrom call order is
      // runs → agents.
      mockFrom.mockReturnValueOnce(runsChain).mockReturnValueOnce(agentsChain);

      await db.getStats();

      // .eq might still be called for other filters via .gte chain, but never for user_id
      const userIdEqCalls = (runsChain.eq as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === "user_id",
      );
      expect(userIdEqCalls).toHaveLength(0);
    });

    it("getStats reduces cache_savings_today across rows (JS fan-out)", async () => {
      const today = new Date().toISOString();
      const agentsChain = mockChain({ count: 0 });
      const runsChain = mockChain({
        data: [
          {
            status: "completed",
            usage_total_tokens: 100,
            usage_cache_savings_usd: 0.42,
            created_at: today,
            user_id: "u",
          },
          {
            status: "completed",
            usage_total_tokens: 100,
            usage_cache_savings_usd: 0.42,
            created_at: today,
            user_id: "u",
          },
        ],
      });
      // supabase.ts builds the runs query FIRST (outside Promise.all), then
      // calls from("agents") inside Promise.all — so mockFrom call order is
      // runs → agents.
      mockFrom.mockReturnValueOnce(runsChain).mockReturnValueOnce(agentsChain);

      const stats = await db.getStats();
      expect(stats.cache_savings_today).toBeCloseTo(0.84, 6);
      expect(stats.daily_cache_savings).toHaveLength(7);
      // Today is index 6 (last)
      expect(stats.daily_cache_savings[6]).toBeCloseTo(0.84, 6);
    });
  });
});
