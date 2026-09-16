/**
 * Byte-budgeted LRU for decoded, memory-heavy artefacts: rendered page
 * canvases, ImageBitmaps, decoded row windows.
 *
 * Why this exists: a 400-page PDF rendered at 2x DPR is several GB of canvas
 * if nothing evicts. Browsers do not surface allocation failure usefully —
 * the tab simply dies — so the budget has to be tracked by us, in bytes,
 * with explicit disposal. `undefined` from `get()` is always a valid answer
 * and callers must be able to re-render.
 */

export interface MemoryEntry<T = unknown> {
  value: T;
  bytes: number;
  dispose?: (value: T) => void;
}

export interface MemoryStats {
  used: number;
  budget: number;
  entries: number;
  pinned: number;
  evictions: number;
  /** 0..1 */
  pressure: number;
}

const DEFAULT_BUDGET = 256 * 1024 * 1024;

/** Pick a budget from the heap limit where the engine tells us, else 256 MB. */
export function defaultBudget(): number {
  const perf = globalThis.performance as { memory?: { jsHeapSizeLimit?: number } } | undefined;
  const limit = perf?.memory?.jsHeapSizeLimit;
  if (typeof limit === 'number' && limit > 0) {
    // Leave the majority of the heap to the app and to undecoded buffers.
    return Math.max(64 * 1024 * 1024, Math.min(DEFAULT_BUDGET, Math.floor(limit * 0.35)));
  }
  return DEFAULT_BUDGET;
}

export class MemoryManager {
  /** Insertion order is the LRU order; re-inserting on read moves to newest. */
  private readonly map = new Map<string, MemoryEntry>();
  private readonly pins = new Set<string>();
  private usedBytes = 0;
  private evictionCount = 0;
  private readonly listeners = new Set<(stats: MemoryStats) => void>();

  constructor(public budget: number = defaultBudget()) {}

  get used(): number {
    return this.usedBytes;
  }

  get pressure(): number {
    return this.budget <= 0 ? 1 : Math.min(1, this.usedBytes / this.budget);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get<T>(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Touch: delete + re-set moves the key to the newest position.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value as T;
  }

  /**
   * Store a value. Oversized single values are rejected rather than evicting
   * the whole cache for something that will never fit.
   * @returns false when the value was not stored (and was disposed).
   */
  set<T>(key: string, value: T, bytes: number, dispose?: (value: T) => void): boolean {
    this.delete(key);
    const cost = Math.max(0, Math.floor(bytes));
    if (cost > this.budget) {
      dispose?.(value);
      return false;
    }
    this.evictTo(this.budget - cost);
    this.map.set(key, { value, bytes: cost, dispose: dispose as MemoryEntry['dispose'] });
    this.usedBytes += cost;
    this.emit();
    return true;
  }

  /** True if `bytes` can be accommodated, evicting unpinned entries if needed. */
  reserve(bytes: number): boolean {
    if (bytes > this.budget) return false;
    this.evictTo(this.budget - bytes);
    return this.usedBytes + bytes <= this.budget;
  }

  /** Protect an entry from eviction (e.g. the page currently on screen). */
  pin(key: string): void {
    if (this.map.has(key)) this.pins.add(key);
  }

  unpin(key: string): void {
    this.pins.delete(key);
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.pins.delete(key);
    this.usedBytes -= entry.bytes;
    safeDispose(entry);
    this.emit();
  }

  /** Drop every entry whose key starts with `prefix`. Used to dispose a doc. */
  clearScope(prefix: string): void {
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) this.delete(key);
    }
  }

  clear(): void {
    for (const entry of this.map.values()) safeDispose(entry);
    this.map.clear();
    this.pins.clear();
    this.usedBytes = 0;
    this.emit();
  }

  /** Evict oldest unpinned entries until `used <= target`. */
  evictTo(target: number): void {
    if (this.usedBytes <= target) return;
    for (const key of this.map.keys()) {
      if (this.usedBytes <= target) break;
      if (this.pins.has(key)) continue;
      this.evictionCount++;
      this.delete(key);
    }
  }

  stats(): MemoryStats {
    return {
      used: this.usedBytes,
      budget: this.budget,
      entries: this.map.size,
      pinned: this.pins.size,
      evictions: this.evictionCount,
      pressure: this.pressure,
    };
  }

  subscribe(listener: (stats: MemoryStats) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A key-prefixed façade over the same budget. Every document gets one so
   * that disposing the document cannot leak, and cannot evict another
   * document's pinned pages by accident.
   */
  scope(prefix: string): ScopedMemory {
    return new ScopedMemory(this, `${prefix}::`);
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const stats = this.stats();
    for (const listener of this.listeners) listener(stats);
  }
}

export class ScopedMemory {
  constructor(
    private readonly parent: MemoryManager,
    private readonly prefix: string,
  ) {}

  get pressure(): number {
    return this.parent.pressure;
  }

  get<T>(key: string): T | undefined {
    return this.parent.get<T>(this.prefix + key);
  }

  set<T>(key: string, value: T, bytes: number, dispose?: (value: T) => void): boolean {
    return this.parent.set(this.prefix + key, value, bytes, dispose);
  }

  has(key: string): boolean {
    return this.parent.has(this.prefix + key);
  }

  delete(key: string): void {
    this.parent.delete(this.prefix + key);
  }

  pin(key: string): void {
    this.parent.pin(this.prefix + key);
  }

  unpin(key: string): void {
    this.parent.unpin(this.prefix + key);
  }

  reserve(bytes: number): boolean {
    return this.parent.reserve(bytes);
  }

  /** Drops only this scope's entries. Call from `doc.dispose()`. */
  dispose(): void {
    this.parent.clearScope(this.prefix);
  }
}

function safeDispose(entry: MemoryEntry): void {
  try {
    entry.dispose?.(entry.value);
  } catch (err) {
    console.warn('[lookglass] cache dispose failed', err);
  }
}

/* -------------------------- size estimation -------------------------- */

/** RGBA backing store for a raster surface. The dominant cost in practice. */
export function rasterBytes(width: number, height: number): number {
  return Math.max(0, Math.ceil(width) * Math.ceil(height) * 4);
}

export function bitmapBytes(bitmap: { width: number; height: number }): number {
  return rasterBytes(bitmap.width, bitmap.height);
}

/** Rough cost of a JS string: 2 bytes/char plus object overhead. */
export function stringBytes(str: string): number {
  return str.length * 2 + 24;
}

/** The single shared budget. Renderers take a `scope()` from this. */
let shared: MemoryManager | undefined;

export function sharedMemory(): MemoryManager {
  shared ??= new MemoryManager();
  return shared;
}

/** Override the global budget, e.g. from `<FileViewer memoryBudget={...}>`. */
export function configureMemory(budgetBytes: number): void {
  const manager = sharedMemory();
  manager.budget = Math.max(16 * 1024 * 1024, Math.floor(budgetBytes));
  manager.evictTo(manager.budget);
}
