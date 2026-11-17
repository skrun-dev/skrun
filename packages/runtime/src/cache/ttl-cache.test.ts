import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TTLCache } from "./ttl-cache.js";

describe("TTLCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("set/get returns stored value (VT-1)", () => {
    const cache = new TTLCache<string, number>({ ttlMs: 60_000, maxEntries: 10 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.size).toBe(1);
  });

  it("get returns undefined for missing key", () => {
    const cache = new TTLCache<string, number>({ ttlMs: 60_000, maxEntries: 10 });
    expect(cache.get("missing")).toBeUndefined();
  });

  it("evicts expired entries on get and calls onEvict (VT-2)", () => {
    const onEvict = vi.fn();
    const cache = new TTLCache<string, number>({ ttlMs: 100, maxEntries: 10, onEvict });
    cache.set("a", 1);

    vi.advanceTimersByTime(150);

    expect(cache.get("a")).toBeUndefined();
    expect(onEvict).toHaveBeenCalledWith("a", 1);
    expect(cache.size).toBe(0);
  });

  it("evicts LRU entry when max capacity reached (VT-3)", () => {
    const onEvict = vi.fn();
    const cache = new TTLCache<string, number>({ ttlMs: 60_000, maxEntries: 2, onEvict });
    cache.set("a", 1);
    cache.set("b", 2);

    // "a" is LRU — adding "c" should evict "a"
    cache.set("c", 3);

    expect(onEvict).toHaveBeenCalledWith("a", 1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("accessing a key updates LRU order", () => {
    const onEvict = vi.fn();
    const cache = new TTLCache<string, number>({ ttlMs: 60_000, maxEntries: 2, onEvict });
    cache.set("a", 1);
    cache.set("b", 2);

    // Access "a" → "a" becomes most recent, "b" becomes LRU
    cache.get("a");
    cache.set("c", 3);

    // "b" should be evicted (was LRU after "a" was accessed)
    expect(onEvict).toHaveBeenCalledWith("b", 2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("delete calls onEvict (VT-4)", () => {
    const onEvict = vi.fn();
    const cache = new TTLCache<string, number>({ ttlMs: 60_000, maxEntries: 10, onEvict });
    cache.set("a", 1);

    expect(cache.delete("a")).toBe(true);
    expect(onEvict).toHaveBeenCalledWith("a", 1);
    expect(cache.size).toBe(0);
  });

  it("delete returns false for missing key", () => {
    const cache = new TTLCache<string, number>({ ttlMs: 60_000, maxEntries: 10 });
    expect(cache.delete("missing")).toBe(false);
  });

  it("clear evicts all entries and calls onEvict for each", () => {
    const onEvict = vi.fn();
    const cache = new TTLCache<string, number>({ ttlMs: 60_000, maxEntries: 10, onEvict });
    cache.set("a", 1);
    cache.set("b", 2);

    cache.clear();

    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it("overwriting a key calls onEvict for old value and refreshes timestamp", () => {
    const onEvict = vi.fn();
    const cache = new TTLCache<string, number>({ ttlMs: 200, maxEntries: 10, onEvict });
    cache.set("a", 1);

    vi.advanceTimersByTime(150);
    cache.set("a", 2); // overwrite — refreshes timestamp

    expect(onEvict).toHaveBeenCalledWith("a", 1);

    vi.advanceTimersByTime(100); // 250ms total, but only 100ms since overwrite
    expect(cache.get("a")).toBe(2); // still alive (TTL reset on overwrite)
  });

  it("accepts custom ttlMs and maxEntries (VT-10)", () => {
    const cache = new TTLCache<string, number>({ ttlMs: 5_000, maxEntries: 3 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(3);

    // Max is 3, adding 4th evicts LRU
    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();

    // TTL is 5s
    vi.advanceTimersByTime(5_100);
    expect(cache.get("b")).toBeUndefined();
  });

  it("sweep removes expired entries without a read, calls onEvict, and reports the count", () => {
    const onEvict = vi.fn();
    const cache = new TTLCache<string, number>({ ttlMs: 100, maxEntries: 10, onEvict });
    cache.set("old", 1);
    vi.advanceTimersByTime(60);
    cache.set("young", 2);
    vi.advanceTimersByTime(60); // "old" is 120 ms old, "young" 60 ms

    expect(cache.sweep()).toBe(1);
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("old", 1);
    expect(cache.size).toBe(1);
    expect(cache.get("young")).toBe(2);
    expect(cache.sweep()).toBe(0);
  });

  // ── Opt-in: a byte budget, besides the count ──
  describe("a budget in bytes", () => {
    /** A cache whose values weigh their own number, under `maxBytes`. */
    function budgeted(maxBytes: number, maxEntries = 10, onEvict = vi.fn()) {
      const sizeOf = vi.fn((value: number) => value);
      const cache = new TTLCache<string, number>({
        ttlMs: 100,
        maxEntries,
        onEvict,
        budget: { maxBytes, sizeOf },
      });
      return { cache, onEvict, sizeOf };
    }

    it("without one, nothing is weighed, and every value is kept", () => {
      const cache = new TTLCache<string, number>({ ttlMs: 60_000, maxEntries: 10 });
      expect(cache.set("a", 1_000_000)).toBe(true);
      expect(cache.bytes).toBe(0);
    });

    it("weighs each value once, when it is set, and counts what they weigh together", () => {
      const { cache, sizeOf } = budgeted(100);
      cache.set("a", 30);
      cache.set("b", 40);
      cache.get("a");
      expect(cache.bytes).toBe(70);
      expect(sizeOf).toHaveBeenCalledTimes(2);
    });

    it("a value that would go past it pushes the least recently used out first, until it fits, each through onEvict", () => {
      const { cache, onEvict } = budgeted(100);
      cache.set("a", 30);
      cache.set("b", 30);
      cache.set("c", 30);
      cache.get("a"); // "b" is now the least recently used, then "c"

      expect(cache.set("d", 60)).toBe(true);
      expect(onEvict.mock.calls).toEqual([
        ["b", 30],
        ["c", 30],
      ]);
      expect(cache.get("a")).toBe(30);
      expect(cache.get("d")).toBe(60);
      expect(cache.size).toBe(2);
      expect(cache.bytes).toBe(90);
    });

    it("a value exactly at what is left is kept, nothing evicted", () => {
      const { cache, onEvict } = budgeted(100);
      cache.set("a", 40);
      expect(cache.set("b", 60)).toBe(true);
      expect(onEvict).not.toHaveBeenCalled();
      expect(cache.bytes).toBe(100);
    });

    it("a value heavier than the whole budget is not kept, and evicts nothing", () => {
      const { cache, onEvict } = budgeted(100);
      cache.set("a", 50);
      expect(cache.set("huge", 101)).toBe(false);
      expect(cache.get("huge")).toBeUndefined();
      expect(cache.get("a")).toBe(50);
      expect(onEvict).not.toHaveBeenCalled();
      expect(cache.bytes).toBe(50);
    });

    it("a value of the whole budget is kept, alone", () => {
      const { cache } = budgeted(100);
      cache.set("a", 50);
      expect(cache.set("all", 100)).toBe(true);
      expect(cache.size).toBe(1);
      expect(cache.bytes).toBe(100);
    });

    it("the count still bounds it", () => {
      const { cache, onEvict } = budgeted(1_000, 2);
      cache.set("a", 1);
      cache.set("b", 1);
      cache.set("c", 1);
      expect(onEvict).toHaveBeenCalledWith("a", 1);
      expect(cache.size).toBe(2);
      expect(cache.bytes).toBe(2);
    });

    it("every way out gives the weight back: a delete, an expiry found by a read or a sweep, a key set again, a clear", () => {
      const { cache } = budgeted(1_000);
      cache.set("deleted", 1);
      cache.set("read", 10);
      cache.set("swept", 100);
      cache.delete("deleted");
      expect(cache.bytes).toBe(110);

      vi.advanceTimersByTime(150);
      expect(cache.get("read")).toBeUndefined();
      expect(cache.bytes).toBe(100);
      expect(cache.sweep()).toBe(1);
      expect(cache.bytes).toBe(0);

      cache.set("k", 200);
      cache.set("k", 300);
      expect(cache.bytes).toBe(300);
      cache.clear();
      expect(cache.bytes).toBe(0);
    });

    it("a key set again with a value too heavy loses its old value too", () => {
      const { cache, onEvict } = budgeted(100);
      cache.set("k", 50);
      expect(cache.set("k", 101)).toBe(false);
      expect(onEvict).toHaveBeenCalledWith("k", 50);
      expect(cache.get("k")).toBeUndefined();
      expect(cache.bytes).toBe(0);
    });
  });
});
