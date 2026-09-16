import type { ScopedMemory } from '../../core/memory.js';
import { stringBytes } from '../../core/memory.js';
import type { RpcClient } from '../../core/rpc.js';
import type { TextWorkerHandlers } from '../../workers/text.worker.js';

/** Lines are fetched in fixed blocks so scrolling does not thrash the worker. */
export const BLOCK_LINES = 512;

/**
 * Windowed view over a text document held in the worker.
 *
 * Blocks live in the shared byte budget, so a user scrolling through a huge
 * log evicts old blocks automatically instead of accumulating the whole file
 * in the tab. Cache misses are normal and render as a skeleton row, never as
 * an error.
 */
export class LineStore {
  private readonly pending = new Map<number, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  /** Bumped on every block arrival so React can re-read via useSyncExternalStore. */
  private revision = 0;

  constructor(
    private readonly client: RpcClient<TextWorkerHandlers>,
    private readonly memory: ScopedMemory,
    private readonly lineCount: number,
  ) {}

  getVersion = (): number => this.revision;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Synchronous cache read. `undefined` means "not loaded yet". */
  getLine(index: number): string | undefined {
    const block = Math.floor(index / BLOCK_LINES);
    const lines = this.memory.get<string[]>(`lines:${block}`);
    return lines?.[index - block * BLOCK_LINES];
  }

  /** Request every block covering `[start, end)`. Safe to call each render. */
  ensureRange(start: number, end: number): void {
    const firstBlock = Math.floor(Math.max(0, start) / BLOCK_LINES);
    const lastBlock = Math.floor(Math.max(0, Math.min(end, this.lineCount) - 1) / BLOCK_LINES);
    for (let block = firstBlock; block <= lastBlock; block++) this.ensureBlock(block);
  }

  private ensureBlock(block: number): void {
    const key = `lines:${block}`;
    if (this.memory.has(key)) {
      // Touch so the visible window is the last thing to be evicted.
      this.memory.get(key);
      return;
    }
    if (this.pending.has(block)) return;

    const start = block * BLOCK_LINES;
    const end = Math.min(start + BLOCK_LINES, this.lineCount);

    const request = this.client
      .call('getLines', { start, end })
      .then((lines) => {
        const bytes = lines.reduce((sum, line) => sum + stringBytes(line), 0);
        this.memory.set(key, lines, bytes);
        this.revision++;
        for (const listener of this.listeners) listener();
      })
      .catch((err) => {
        // Aborts happen constantly during fast scrolling and on unmount; they
        // are not failures and must not surface to the user.
        if ((err as { name?: string })?.name !== 'AbortError') {
          console.warn('[lookglass] line block failed', err);
        }
      })
      .finally(() => {
        this.pending.delete(block);
      });

    this.pending.set(block, request);
  }
}
