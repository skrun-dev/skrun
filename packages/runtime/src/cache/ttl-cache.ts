/**
 * Generic in-memory cache with TTL expiration and LRU eviction.
 * Uses Map insertion order for LRU tracking (delete + re-insert on access).
 */
export interface TTLCacheOptions<K, V> {
  ttlMs: number;
  maxEntries: number;
  onEvict?: (key: K, value: V) => void;
}

interface CacheEntry<V> {
  value: V;
  timestamp: number;
}

export class TTLCache<K, V> {
  private map = new Map<K, CacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(options: TTLCacheOptions<K, V>) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.onEvict = options.onEvict;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.map.delete(key);
      this.onEvict?.(key, entry.value);
      return undefined;
    }

    // Update LRU order: delete + re-insert moves to end (most recent)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    // If key exists, remove it first (will be re-inserted at end)
    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
      this.onEvict?.(key, existing.value);
    }

    // Evict LRU if at capacity
    if (this.map.size >= this.maxEntries) {
      const lruKey = this.map.keys().next().value as K;
      const lruEntry = this.map.get(lruKey);
      this.map.delete(lruKey);
      if (lruEntry) {
        this.onEvict?.(lruKey, lruEntry.value);
      }
    }

    this.map.set(key, { value, timestamp: Date.now() });
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.map.delete(key);
    this.onEvict?.(key, entry.value);
    return true;
  }

  clear(): void {
    for (const [key, entry] of this.map) {
      this.onEvict?.(key, entry.value);
    }
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
