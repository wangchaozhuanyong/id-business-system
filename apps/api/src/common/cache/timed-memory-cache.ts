interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class TimedMemoryCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly pending = new Map<string, Promise<unknown>>();

  get<T>(key: string) {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number) {
    if (ttlMs <= 0) {
      this.entries.delete(key);
      return;
    }

    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });
  }

  async getOrSet<T>(key: string, ttlMs: number, loader: () => Promise<T>) {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const existingPending = this.pending.get(key);
    if (existingPending) {
      return existingPending as Promise<T>;
    }

    const pending = loader()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.pending.delete(key);
      });

    this.pending.set(key, pending);
    return pending;
  }

  delete(key: string) {
    this.entries.delete(key);
    this.pending.delete(key);
  }

  clear() {
    this.entries.clear();
    this.pending.clear();
  }
}
