import type { RpcContext } from '../core/rpc.js';
import type { Source } from '../source/types.js';
import type { SearchHit } from '../types.js';
import { ByteWindow, ExpansionState, NodeTable, type TreeRow } from './tree-model.js';

/**
 * Everything a tree document does that is not format-specific.
 *
 * JSON and XML differ only in how bytes become a node table and how a node
 * becomes a row. Expansion, windowed row serving, search-and-reveal and path
 * resolution are identical, so they live here once — which is also why the
 * search behaviour is guaranteed consistent between the two formats.
 */

const SEARCH_HIT_LIMIT = 2000;
const SEARCH_CHUNK = 1 << 20;

export interface RowFormatter {
  /** Build rows for the given node indices. Reads are the formatter's job. */
  buildRows(indices: number[], signal?: AbortSignal): Promise<TreeRow[]>;
  /** Human-readable path to a node, e.g. `$.items[3].name` or `/root/item[2]`. */
  buildPath(index: number, signal?: AbortSignal): Promise<string>;
}

export class TreeService {
  readonly expansion: ExpansionState;

  constructor(
    readonly table: NodeTable,
    readonly window: ByteWindow,
    readonly source: Source,
    private formatter: RowFormatter,
    initialDepth = 2,
    /** Node 0 is a synthetic container that is never shown (XML). */
    hiddenRoot = false,
  ) {
    this.expansion = new ExpansionState(table, hiddenRoot);
    this.expansion.expandToDepth(initialDepth);
  }

  setFormatter(formatter: RowFormatter): void {
    this.formatter = formatter;
  }

  getRows(start: number, end: number, signal?: AbortSignal): Promise<TreeRow[]> {
    return this.formatter.buildRows(this.expansion.slice(start, end), signal);
  }

  toggle(index: number): { visibleCount: number; expanded: boolean } {
    const expanded = this.expansion.toggle(index);
    return { visibleCount: this.expansion.visibleCount(), expanded };
  }

  expandAll(): { visibleCount: number } {
    this.expansion.expandAll();
    return { visibleCount: this.expansion.visibleCount() };
  }

  collapseAll(): { visibleCount: number } {
    this.expansion.collapseAll();
    // Collapsing the root as well would leave an empty view.
    this.expansion.set(0, true);
    return { visibleCount: this.expansion.visibleCount() };
  }

  visibleCount(): number {
    return this.expansion.visibleCount();
  }

  path(index: number, signal?: AbortSignal): Promise<string> {
    return this.formatter.buildPath(index, signal);
  }

  /**
   * Substring search over the raw bytes, mapped back to nodes.
   *
   * Searching the source rather than the tree covers keys, values, element
   * names and attributes in one linear pass, and costs the same whether the
   * tree is fully collapsed or fully expanded. Matched nodes are revealed so
   * the hits are actually reachable.
   */
  async search(
    query: string,
    ctx: RpcContext,
    limit = SEARCH_HIT_LIMIT,
  ): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const needle = query.toLowerCase();
    if (!needle) return { hits: [], truncated: false };

    const total = this.source.size;
    const matches: { node: number; offset: number; excerpt: string }[] = [];
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const overlap = Math.min(512, needle.length * 4);

    let position = 0;
    let carry = '';
    let carryOffset = 0;

    while (position < total && matches.length < limit) {
      ctx.signal.throwIfAborted();
      const end = Math.min(position + SEARCH_CHUNK, total);
      const bytes = await this.source.slice(position, end, ctx.signal);
      const rawText = carry + decoder.decode(bytes, { stream: end < total });
      const haystack = rawText.toLowerCase();

      let at = haystack.indexOf(needle);
      while (at !== -1 && matches.length < limit) {
        const absolute = carryOffset + at;
        matches.push({
          node: this.nodeAtOffset(absolute),
          offset: absolute,
          excerpt: excerptAround(rawText, at, needle.length),
        });
        at = haystack.indexOf(needle, at + needle.length);
      }

      ctx.progress({
        phase: 'indexing',
        bytesDone: end,
        bytesTotal: total,
        ratio: total > 0 ? end / total : 1,
        message: `${matches.length} matches`,
      });

      carry = rawText.slice(Math.max(0, rawText.length - overlap));
      carryOffset += rawText.length - carry.length;
      position = end;
    }

    for (const match of matches) this.expansion.revealPath(match.node);

    // One walk resolves every hit's row position. Doing it per hit would be
    // quadratic on a document with thousands of matches.
    const rowByNode = this.expansion.rowsOf(new Set(matches.map((match) => match.node)));

    return {
      hits: matches.map((match) => ({
        id: `${match.node}:${match.offset}`,
        page: (rowByNode.get(match.node) ?? 0) + 1,
        excerpt: match.excerpt,
        excerptOffset: Math.min(40, match.excerpt.length),
        excerptLength: query.length,
      })) satisfies SearchHit[],
      truncated: matches.length >= limit,
    };
  }

  dispose(): void {
    this.window.dispose();
    this.source.dispose();
  }

  /**
   * Deepest node starting at or before `offset`.
   *
   * Nodes are created in document order, so `valueStart` is non-decreasing
   * and a binary search is valid without storing an interval tree.
   */
  private nodeAtOffset(offset: number): number {
    let low = 0;
    let high = this.table.count - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.table.valueStart[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  }
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).replace(/\s+/g, ' ');
}
