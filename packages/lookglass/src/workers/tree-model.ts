/**
 * Offset-based tree model shared by the JSON and XML parsers.
 *
 * The central decision: nodes store *byte offsets*, never materialised
 * values. `JSON.parse` on a 300 MB document allocates a JS object graph
 * several times the file size and blocks the thread for tens of seconds; an
 * offset table costs ~30 bytes per node and is built in a single streaming
 * pass that never holds more than one chunk.
 *
 * Text for a row is extracted only when that row is about to be painted, so
 * the cost of displaying a document is bounded by the viewport rather than by
 * the document.
 */

import type { Source } from '../source/types.js';

// A plain enum, not `const enum`: const enums are not permitted under
// `isolatedModules`, which every modern bundler requires.
export enum NodeKind {
  Object = 1,
  Array = 2,
  String = 3,
  Number = 4,
  Boolean = 5,
  Null = 6,
  Element = 7,
  Text = 8,
  Comment = 9,
  CData = 10,
  Instruction = 11,
  Doctype = 12,
  /** Synthetic, never displayed: the parent of an XML document's top-level nodes. */
  Document = 13,
}

export const CONTAINER_KINDS = new Set<NodeKind>([
  NodeKind.Object,
  NodeKind.Array,
  NodeKind.Element,
  NodeKind.Document,
]);

/** Depth is a byte; documents nested deeper than this are malformed in practice. */
export const MAX_DEPTH = 254;

/** ~30 bytes/node of index, so this caps the index at roughly 150 MB. */
export const MAX_NODES = 5_000_000;

/** Keep the source resident below this size; above it, read ranges on demand. */
export const RESIDENT_LIMIT = 128 * 1024 * 1024;

/** Row previews are truncated: nobody reads a 2 MB string in a tree row. */
export const PREVIEW_CHARS = 200;

export interface TreeRow {
  index: number;
  depth: number;
  /** Object key, array index, or element name. */
  key: string;
  kind: NodeKind;
  /** Scalar value, or a summary like `{3}` / `[1024]` for containers. */
  preview: string;
  childCount: number;
  expanded: boolean;
  /** Dotted/bracketed path, for copy-path and deep linking. */
  path: string;
  /** Element attributes, rendered inline. XML only. */
  attributes?: [string, string][];
  /** Set when the value shown is a clipped prefix of a much longer one. */
  clipped?: boolean;
}

export interface TreeStats {
  nodeCount: number;
  truncated: boolean;
  maxDepth: number;
  byteLength: number;
}

/**
 * Parallel typed arrays rather than an array of objects.
 *
 * At a million nodes the difference is not stylistic: objects cost several
 * hundred megabytes and stall GC, while these arrays are flat and stay in
 * cache during a tree walk.
 */
export class NodeTable {
  kinds: Uint8Array;
  depths: Uint8Array;
  parents: Int32Array;
  firstChild: Int32Array;
  nextSibling: Int32Array;
  lastChild: Int32Array;
  childCounts: Uint32Array;
  /** Float64 so offsets past 4 GB stay exact. */
  keyStart: Float64Array;
  keyEnd: Float64Array;
  valueStart: Float64Array;
  valueEnd: Float64Array;
  /**
   * Format-specific secondary span. XML stores the attribute list here so it
   * can be parsed lazily, per visible row, instead of eagerly for every
   * element in the document. JSON leaves it zeroed.
   */
  auxStart: Float64Array;
  auxEnd: Float64Array;

  count = 0;
  maxDepth = 0;
  truncated = false;

  private capacity: number;

  constructor(initialCapacity = 4096) {
    this.capacity = Math.max(16, initialCapacity);
    this.kinds = new Uint8Array(this.capacity);
    this.depths = new Uint8Array(this.capacity);
    this.parents = new Int32Array(this.capacity);
    this.firstChild = new Int32Array(this.capacity).fill(-1);
    this.nextSibling = new Int32Array(this.capacity).fill(-1);
    this.lastChild = new Int32Array(this.capacity).fill(-1);
    this.childCounts = new Uint32Array(this.capacity);
    this.keyStart = new Float64Array(this.capacity);
    this.keyEnd = new Float64Array(this.capacity);
    this.valueStart = new Float64Array(this.capacity);
    this.valueEnd = new Float64Array(this.capacity);
    this.auxStart = new Float64Array(this.capacity);
    this.auxEnd = new Float64Array(this.capacity);
  }

  /** @returns the new node index, or -1 once the node cap is reached. */
  push(kind: NodeKind, parent: number, depth: number, keyStart: number, keyEnd: number, valueStart: number): number {
    if (this.count >= MAX_NODES) {
      this.truncated = true;
      return -1;
    }
    if (this.count >= this.capacity) this.grow();

    const index = this.count++;
    this.kinds[index] = kind;
    this.depths[index] = Math.min(depth, MAX_DEPTH);
    this.parents[index] = parent;
    this.keyStart[index] = keyStart;
    this.keyEnd[index] = keyEnd;
    this.valueStart[index] = valueStart;
    this.valueEnd[index] = valueStart;
    if (depth > this.maxDepth) this.maxDepth = depth;

    if (parent >= 0) {
      this.childCounts[parent]!++;
      const last = this.lastChild[parent]!;
      if (last === -1) this.firstChild[parent] = index;
      else this.nextSibling[last] = index;
      this.lastChild[parent] = index;
    }

    return index;
  }

  close(index: number, valueEnd: number): void {
    if (index >= 0) this.valueEnd[index] = valueEnd;
  }

  isContainer(index: number): boolean {
    return CONTAINER_KINDS.has(this.kinds[index] as NodeKind);
  }

  private grow(): void {
    const next = Math.min(MAX_NODES, this.capacity * 2);
    const grow8 = (a: Uint8Array) => {
      const b = new Uint8Array(next);
      b.set(a);
      return b;
    };
    const grow32 = (a: Int32Array, fill: number) => {
      const b = new Int32Array(next).fill(fill);
      b.set(a);
      return b;
    };
    const growU32 = (a: Uint32Array) => {
      const b = new Uint32Array(next);
      b.set(a);
      return b;
    };
    const grow64 = (a: Float64Array) => {
      const b = new Float64Array(next);
      b.set(a);
      return b;
    };

    this.kinds = grow8(this.kinds);
    this.depths = grow8(this.depths);
    this.parents = grow32(this.parents, 0);
    this.firstChild = grow32(this.firstChild, -1);
    this.nextSibling = grow32(this.nextSibling, -1);
    this.lastChild = grow32(this.lastChild, -1);
    this.childCounts = growU32(this.childCounts);
    this.keyStart = grow64(this.keyStart);
    this.keyEnd = grow64(this.keyEnd);
    this.valueStart = grow64(this.valueStart);
    this.valueEnd = grow64(this.valueEnd);
    this.auxStart = grow64(this.auxStart);
    this.auxEnd = grow64(this.auxEnd);
    this.capacity = next;
  }
}

/* ------------------------------------------------------------------ *
 * Byte access
 * ------------------------------------------------------------------ */

/**
 * Reads the byte ranges a visible window needs.
 *
 * Under `RESIDENT_LIMIT` the whole file stays in the worker and extraction is
 * synchronous. Above it, ranges are fetched on demand and nearby ranges are
 * merged into single reads — a window of 60 tree rows scattered through a
 * 2 GB file must not become 60 HTTP requests.
 */
export class ByteWindow {
  private resident: Uint8Array | undefined;
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  constructor(
    private readonly source: Source,
    resident?: Uint8Array,
  ) {
    this.resident = resident;
  }

  static async create(source: Source): Promise<ByteWindow> {
    if (source.size >= 0 && source.size <= RESIDENT_LIMIT) {
      return new ByteWindow(source, await source.bytes({ maxBytes: RESIDENT_LIMIT }));
    }
    return new ByteWindow(source);
  }

  get isResident(): boolean {
    return this.resident !== undefined;
  }

  /** Merge ranges within this distance into one read. */
  private static readonly MERGE_GAP = 64 * 1024;
  /** Never issue more than this many reads for one window. */
  private static readonly MAX_READS = 12;

  /**
   * Fetch every requested range, returning decoded text per range.
   * Ranges are returned in the order given, regardless of read batching.
   */
  async read(ranges: { start: number; end: number }[], signal?: AbortSignal): Promise<string[]> {
    if (ranges.length === 0) return [];

    if (this.resident) {
      return ranges.map((range) => this.decoder.decode(this.resident!.subarray(range.start, range.end)));
    }

    const order = ranges.map((range, index) => ({ ...range, index })).sort((a, b) => a.start - b.start);

    const batches: { start: number; end: number; members: typeof order }[] = [];
    for (const range of order) {
      const last = batches[batches.length - 1];
      if (last && range.start - last.end <= ByteWindow.MERGE_GAP && batches.length <= ByteWindow.MAX_READS) {
        last.end = Math.max(last.end, range.end);
        last.members.push(range);
      } else {
        batches.push({ start: range.start, end: range.end, members: [range] });
      }
    }

    const out = new Array<string>(ranges.length).fill('');
    await Promise.all(
      batches.map(async (batch) => {
        const bytes = await this.source.slice(batch.start, batch.end, signal);
        for (const member of batch.members) {
          out[member.index] = this.decoder.decode(
            bytes.subarray(member.start - batch.start, member.end - batch.start),
          );
        }
      }),
    );
    return out;
  }

  /** Synchronous read; only valid when the source is resident. */
  readSync(start: number, end: number): string {
    if (!this.resident) throw new Error('Source is not resident; use read().');
    return this.decoder.decode(this.resident.subarray(start, end));
  }

  bytes(): Uint8Array | undefined {
    return this.resident;
  }

  dispose(): void {
    this.resident = undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Expansion state and flattening
 * ------------------------------------------------------------------ */

/**
 * Which containers are open, and the resulting visible row count.
 *
 * The state lives in the worker so the main thread never walks the tree.
 * Expanding a node with a million children changes one number here; the UI
 * just sees a taller scroll range.
 *
 * With `hiddenRoot`, node 0 is a synthetic container that is always open and
 * never shown. XML needs it: a document can have a comment, a processing
 * instruction or a DOCTYPE *beside* its root element, so there is no single
 * real root to start the walk from.
 */
export class ExpansionState {
  private readonly expanded = new Set<number>();
  private visibleCountCache = -1;

  constructor(
    private readonly table: NodeTable,
    private readonly hiddenRoot = false,
  ) {
    if (hiddenRoot && table.count > 0) this.expanded.add(0);
  }

  isExpanded(index: number): boolean {
    return this.expanded.has(index);
  }

  toggle(index: number): boolean {
    if (!this.table.isContainer(index) || this.isPinned(index)) return this.expanded.has(index);
    if (this.expanded.has(index)) this.expanded.delete(index);
    else this.expanded.add(index);
    this.visibleCountCache = -1;
    return this.expanded.has(index);
  }

  set(index: number, open: boolean): void {
    if (!this.table.isContainer(index) || this.isPinned(index)) return;
    if (open) this.expanded.add(index);
    else this.expanded.delete(index);
    this.visibleCountCache = -1;
  }

  /** Open every container down to `depth`. Used for the initial view. */
  expandToDepth(depth: number): void {
    for (let index = 0; index < this.table.count; index++) {
      if (this.table.depths[index]! < depth && this.table.isContainer(index)) this.expanded.add(index);
    }
    this.visibleCountCache = -1;
  }

  expandAll(): void {
    for (let index = 0; index < this.table.count; index++) {
      if (this.table.isContainer(index)) this.expanded.add(index);
    }
    this.visibleCountCache = -1;
  }

  collapseAll(): void {
    this.expanded.clear();
    if (this.hiddenRoot && this.table.count > 0) this.expanded.add(0);
    this.visibleCountCache = -1;
  }

  /** Open every ancestor of `index` so it becomes visible. */
  revealPath(index: number): void {
    let cursor = this.table.parents[index] ?? -1;
    while (cursor >= 0) {
      this.expanded.add(cursor);
      cursor = this.table.parents[cursor] ?? -1;
    }
    this.visibleCountCache = -1;
  }

  visibleCount(): number {
    if (this.visibleCountCache === -1) {
      let count = 0;
      this.walk(() => {
        count++;
        return true;
      });
      this.visibleCountCache = count;
    }
    return this.visibleCountCache;
  }

  /**
   * Node indices for visible rows `[start, end)`.
   *
   * This walks from the top each time, which is O(visible rows before the
   * window). That is acceptable because the walk touches only typed arrays
   * and never descends into collapsed subtrees, so the cost is bounded by the
   * row count rather than the node count.
   */
  slice(start: number, end: number): number[] {
    const out: number[] = [];
    if (end <= start) return out;
    this.walk((index, row) => {
      if (row >= end) return false;
      if (row >= start) out.push(index);
      return true;
    });
    return out;
  }

  /** Visible row index for each node in `wanted`, in a single walk. */
  rowsOf(wanted: Set<number>): Map<number, number> {
    const out = new Map<number, number>();
    if (wanted.size === 0) return out;
    this.walk((index, row) => {
      if (wanted.has(index)) out.set(index, row);
      return out.size < wanted.size;
    });
    return out;
  }

  /**
   * Pre-order walk over visible rows. The single implementation behind
   * counting, slicing and hit positioning, so the three can never disagree
   * about which row a node is on.
   */
  private walk(visit: (index: number, row: number) => boolean): void {
    if (this.table.count === 0) return;

    const stack: number[] = [];
    if (this.hiddenRoot) this.pushChildren(stack, 0);
    else stack.push(0);

    let row = 0;
    while (stack.length > 0) {
      const index = stack.pop()!;
      if (!visit(index, row)) return;
      row++;
      if (this.expanded.has(index) && this.table.isContainer(index)) this.pushChildren(stack, index);
    }
  }

  /** Push children in reverse so they pop in document order. */
  private pushChildren(stack: number[], index: number): void {
    const from = stack.length;
    for (let child = this.table.firstChild[index]!; child !== -1; child = this.table.nextSibling[child]!) {
      stack.push(child);
    }
    // Reverse only the portion just pushed.
    for (let i = from, j = stack.length - 1; i < j; i++, j--) {
      const swap = stack[i]!;
      stack[i] = stack[j]!;
      stack[j] = swap;
    }
  }

  private isPinned(index: number): boolean {
    return this.hiddenRoot && index === 0;
  }
}

/** Build the dotted/bracketed path for a node, walking to the root. */
export function buildPath(table: NodeTable, index: number, keyOf: (node: number) => string): string {
  const parts: string[] = [];
  let cursor = index;
  while (cursor > 0) {
    const parent = table.parents[cursor]!;
    parts.push(table.kinds[parent] === NodeKind.Array ? `[${keyOf(cursor)}]` : `.${keyOf(cursor)}`);
    cursor = parent;
  }
  parts.reverse();
  return `$${parts.join('')}`;
}

/** Collapse whitespace and clip, so one row can never blow up layout. */
export function truncatePreview(text: string, limit = PREVIEW_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}
