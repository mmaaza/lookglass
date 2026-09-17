import type { ScopedMemory } from '../../core/memory.js';
import { stringBytes } from '../../core/memory.js';
import type { RpcClient, RpcHandlers } from '../../core/rpc.js';
import type { TreeRow } from '../../workers/tree-model.js';

export const TREE_BLOCK_ROWS = 128;

/**
 * Worker-backed RPC surface a tree document must expose. JSON and XML both
 * implement it, which is what lets them share this store and the surface.
 */
export interface TreeClientApi extends RpcHandlers {
  getRows: (args: { start: number; end: number }) => Promise<TreeRow[]>;
  toggle: (args: { index: number }) => { visibleCount: number; expanded: boolean };
  expandAll: () => { visibleCount: number };
  collapseAll: () => { visibleCount: number };
  visibleCount: () => number;
  path: (args: { index: number }) => Promise<string>;
}

/**
 * Windowed row cache over a tree held in a worker.
 *
 * The subtlety here is invalidation. Row indices are positions in a flattened
 * view, so expanding one node shifts the meaning of every row after it. The
 * cache is therefore generation-stamped and dropped wholesale on any
 * structural change — stale rows would render the wrong nodes at the wrong
 * depths, which looks like corruption rather than a cache miss.
 */
export class TreeStore {
  private generation = 0;
  private revision = 0;
  private visible: number;
  private readonly pending = new Set<number>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly client: RpcClient<TreeClientApi>,
    private readonly memory: ScopedMemory,
    initialVisibleCount: number,
  ) {
    this.visible = initialVisibleCount;
  }

  get visibleCount(): number {
    return this.visible;
  }

  getVersion = (): number => this.revision;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getRow(index: number): TreeRow | undefined {
    const block = Math.floor(index / TREE_BLOCK_ROWS);
    const rows = this.memory.get<TreeRow[]>(this.key(block));
    return rows?.[index - block * TREE_BLOCK_ROWS];
  }

  ensureRange(start: number, end: number): void {
    const first = Math.floor(Math.max(0, start) / TREE_BLOCK_ROWS);
    const last = Math.floor(Math.max(0, Math.min(end, this.visible) - 1) / TREE_BLOCK_ROWS);
    for (let block = first; block <= last; block++) this.ensureBlock(block);
  }

  async toggle(index: number): Promise<void> {
    const result = await this.client.call('toggle', { index });
    this.invalidate(result.visibleCount);
  }

  async expandAll(): Promise<void> {
    this.invalidate((await this.client.call('expandAll', undefined as never)).visibleCount);
  }

  async collapseAll(): Promise<void> {
    this.invalidate((await this.client.call('collapseAll', undefined as never)).visibleCount);
  }

  /**
   * Re-read the visible count after something else changed the tree — search
   * reveals matched nodes, which expands their ancestors behind our back.
   */
  async resync(): Promise<void> {
    this.invalidate(await this.client.call('visibleCount', undefined as never));
  }

  path(index: number): Promise<string> {
    return this.client.call('path', { index });
  }

  private invalidate(visibleCount: number): void {
    this.generation++;
    this.visible = visibleCount;
    this.pending.clear();
    // Drop every cached block: row indices no longer mean the same nodes.
    this.memory.dispose();
    this.emit();
  }

  private key(block: number): string {
    return `rows:${this.generation}:${block}`;
  }

  private ensureBlock(block: number): void {
    const key = this.key(block);
    if (this.memory.has(key)) {
      this.memory.get(key);
      return;
    }
    if (this.pending.has(block)) return;
    this.pending.add(block);

    const generation = this.generation;
    const start = block * TREE_BLOCK_ROWS;
    const end = Math.min(start + TREE_BLOCK_ROWS, this.visible);

    void this.client
      .call('getRows', { start, end })
      .then((rows) => {
        // A toggle may have landed while this was in flight; those rows now
        // describe a tree that no longer exists.
        if (generation !== this.generation) return;
        const bytes = rows.reduce((sum, row) => sum + stringBytes(row.key) + stringBytes(row.preview) + 64, 0);
        this.memory.set(key, rows, bytes);
        this.revision++;
        this.emit();
      })
      .catch((err) => {
        if ((err as { name?: string })?.name !== 'AbortError') {
          console.warn('[lookglass] tree rows failed', err);
        }
      })
      .finally(() => {
        this.pending.delete(block);
      });
  }

  private emit(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
