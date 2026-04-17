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
});
