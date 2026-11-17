/**
 * Generic in-memory cache with TTL expiration and LRU eviction.
 * Uses Map insertion order for LRU tracking (delete + re-insert on access).
 */
export interface TTLCacheOptions<K, V> {
  ttlMs: number;
  maxEntries: number;
  onEvict?: (key: K, value: V) => void;
  /**
   * Opt-in: a bound on what the entries weigh together, besides their count.
   * Each value is weighed once, when it is set (`sizeOf`); a value that would
   * take the cache past `maxBytes` pushes the least recently used entries out
   * first, each through `onEvict`, and a value heavier than `maxBytes` alone is
   * not kept (`set` returns false). Without it, nothing is weighed.
   */
  budget?: {
    maxBytes: number;
    sizeOf: (value: V) => number;
  };
}

interface CacheEntry<V> {
  value: V;
  timestamp: number;
  /** What `budget.sizeOf` weighed the value at when it was set; 0 without a budget. */
  bytes: number;
}

export class TTLCache<K, V> {
  private map = new Map<K, CacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly onEvict?: (key: K, value: V) => void;
  private readonly budget?: TTLCacheOptions<K, V>["budget"];
  private totalBytes = 0;

  constructor(options: TTLCacheOptions<K, V>) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.onEvict = options.onEvict;
    this.budget = options.budget;
  }

  /** Take an entry out of the map and out of the weight it counts in — no `onEvict`. */
  private remove(key: K, entry: CacheEntry<V>): void {
    this.map.delete(key);
    this.totalBytes -= entry.bytes;
  }

  /** Take the least recently used entry out, through `onEvict`. */
  private evictLeastRecent(): void {
    const lruKey = this.map.keys().next().value as K;
    const lruEntry = this.map.get(lruKey);
    if (!lruEntry) return;
    this.remove(lruKey, lruEntry);
    this.onEvict?.(lruKey, lruEntry.value);
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.remove(key, entry);
      this.onEvict?.(key, entry.value);
      return undefined;
    }

    // Update LRU order: delete + re-insert moves to end (most recent)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * Keep `value` under `key`, the value it held before evicted. Returns false
   * — `value` not kept, and no other entry evicted for it — only under a
   * budget, for a value heavier than the whole of it; true otherwise.
   */
  set(key: K, value: V): boolean {
    // If key exists, remove it first (will be re-inserted at end)
    const existing = this.map.get(key);
    if (existing) {
      this.remove(key, existing);
      this.onEvict?.(key, existing.value);
    }

    const bytes = this.budget ? this.budget.sizeOf(value) : 0;
    if (this.budget && bytes > this.budget.maxBytes) return false;

    // Evict LRU if at capacity
    if (this.map.size >= this.maxEntries) {
      this.evictLeastRecent();
    }
    // Under a budget, the least recently used leave until the value fits.
    if (this.budget) {
      while (this.map.size > 0 && this.totalBytes + bytes > this.budget.maxBytes) {
        this.evictLeastRecent();
      }
    }

    this.map.set(key, { value, timestamp: Date.now(), bytes });
    this.totalBytes += bytes;
    return true;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.remove(key, entry);
    this.onEvict?.(key, entry.value);
    return true;
  }

  clear(): void {
    for (const [key, entry] of this.map) {
      this.onEvict?.(key, entry.value);
    }
    this.map.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  /** What the entries weigh together, as the budget weighed them; 0 without one. */
  get bytes(): number {
    return this.totalBytes;
  }

  /**
   * Remove every expired entry now, without waiting for a read, calling
   * `onEvict` for each. Returns how many were removed. Expiry on `get` only
   * means an entry nobody asks for again is never evicted; a caller that owns
   * a timer uses this to make the TTL a bound rather than a hint.
   */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (now - entry.timestamp > this.ttlMs) {
        this.remove(key, entry);
        this.onEvict?.(key, entry.value);
        removed++;
      }
    }
    return removed;
  }
}
