import type { ScopedMemory } from '../../core/memory.js';
import { stringBytes } from '../../core/memory.js';
import type { RpcClient } from '../../core/rpc.js';
import type { WireToken } from '../../workers/highlight.js';
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
    /**
     * When set, blocks are fetched as tokens and plain lines are derived from
     * them, so a highlighted document never pays for both reads.
     */
    private highlighted = false,
  ) {}

  get isHighlighted(): boolean {
    return this.highlighted;
  }

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

  /** Tokens for a line, when highlighting is on and the block has arrived. */
  getTokens(index: number): WireToken[] | undefined {
    if (!this.highlighted) return undefined;
    const block = Math.floor(index / BLOCK_LINES);
    return this.memory.get<WireToken[][]>(`tokens:${block}`)?.[index - block * BLOCK_LINES];
  }

  /** Request every block covering `[start, end)`. Safe to call each render. */
  ensureRange(start: number, end: number): void {
    const firstBlock = Math.floor(Math.max(0, start) / BLOCK_LINES);
    const lastBlock = Math.floor(Math.max(0, Math.min(end, this.lineCount) - 1) / BLOCK_LINES);
    for (let block = firstBlock; block <= lastBlock; block++) this.ensureBlock(block);
  }

  private ensureBlock(block: number): void {
    const key = `lines:${block}`;
    // Lines and tokens are budgeted separately, so either can be evicted
    // alone. A block missing its tokens must be refetched, or it would stay
    // uncoloured for the rest of the session.
    const tokensMissing = this.highlighted && !this.memory.has(`tokens:${block}`);
    if (this.memory.has(key) && !tokensMissing) {
      // Touch so the visible window is the last thing to be evicted.
      this.memory.get(key);
      this.memory.get(`tokens:${block}`);
      return;
    }
    if (this.pending.has(block)) return;

    const start = block * BLOCK_LINES;
    const end = Math.min(start + BLOCK_LINES, this.lineCount);

    const request = (this.highlighted ? this.fetchTokens(block, start, end) : this.client.call('getLines', { start, end }))
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

  private async fetchTokens(block: number, start: number, end: number): Promise<string[]> {
    try {
      const tokens = await this.client.call('getTokens', { start, end });
      // Tokens carry colour strings per span, so budget them generously.
      const bytes = tokens.reduce(
        (sum, line) => sum + line.reduce((inner, token) => inner + stringBytes(token[0]) + 64, 24),
        0,
      );
      this.memory.set(`tokens:${block}`, tokens, bytes);
      return tokens.map((line) => line.map((token) => token[0]).join(''));
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw err;
      // A tokenizer failure must never cost the user the text itself.
      console.warn('[lookglass] highlighting failed; falling back to plain text', err);
      this.highlighted = false;
      return this.client.call('getLines', { start, end });
    }
  }
}
