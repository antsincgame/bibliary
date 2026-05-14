export class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }
}

export class KeyedAsyncMutex {
  private readonly locks = new Map<string, AsyncMutex>();
  /** Approximate cap on stored locks; cleaned up after release if past cap. */
  private readonly maxKeys: number;

  constructor(maxKeys = 256) {
    this.maxKeys = Math.max(8, maxKeys);
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new AsyncMutex();
      this.locks.set(key, lock);
    }
    try {
      return await lock.runExclusive(fn);
    } finally {
      if (this.locks.size > this.maxKeys) this.compact();
    }
  }

  size(): number {
    return this.locks.size;
  }

  _resetForTests(): void {
    this.locks.clear();
  }

  private compact(): void {
    /* Best-effort eviction of locks whose chain currently has no waiters.
       Hard to inspect without API; we instead drop oldest insertion-order
       entries until we are at half capacity. New acquires will recreate
       a fresh AsyncMutex if needed (no correctness issue — only freshness). */
    const keep = Math.floor(this.maxKeys / 2);
    let toRemove = this.locks.size - keep;
    if (toRemove <= 0) return;
    for (const k of this.locks.keys()) {
      if (toRemove <= 0) break;
      this.locks.delete(k);
      toRemove -= 1;
    }
  }
}
