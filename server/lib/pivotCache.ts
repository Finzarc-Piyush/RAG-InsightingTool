import crypto from "crypto";

type PivotCacheEntry<T> = {
  value: T;
  expiresAt: number;
  createdAt: number;
};

/**
 * Very small in-memory pivot cache for interactive UX.
 * Key format is controlled by the caller (sessionId + dataVersion + configHash).
 */
class PivotCache<T> {
  private cache = new Map<string, PivotCacheEntry<T>>();
  private readonly defaultTTLms: number;
  private readonly maxEntries: number;

  constructor(opts?: { defaultTTLms?: number; maxEntries?: number }) {
    this.defaultTTLms = opts?.defaultTTLms ?? 5 * 60 * 1000; // 5 minutes
    this.maxEntries = opts?.maxEntries ?? 200;
  }

  get(key: string): { value: T; ageMs: number } | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return { value: entry.value, ageMs: Date.now() - entry.createdAt };
  }

  set(key: string, value: T, ttlMs?: number): void {
    // Simple cap: if over limit, evict random-ish older entries.
    if (this.cache.size >= this.maxEntries) {
      const toEvict = this.cache.size - this.maxEntries + 1;
      const entries = Array.from(this.cache.entries()).sort(
        (a, b) => a[1].createdAt - b[1].createdAt
      );
      for (let i = 0; i < Math.min(toEvict, entries.length); i++) {
        this.cache.delete(entries[i]![0]);
      }
    }

    this.cache.set(key, {
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + (ttlMs ?? this.defaultTTLms),
    });
  }
}

export const pivotCache = new PivotCache<any>();

export function stableHashJson(value: unknown): string {
  const json = stableStringify(value);
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

