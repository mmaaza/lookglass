import { ViewerError } from '../core/errors.js';
import type { Source } from '../source/types.js';
import { MAX_DEPTH, NodeKind, NodeTable } from './tree-model.js';

/**
 * Streaming JSON scanner.
 *
 * It reads the document one chunk at a time and never materialises a value —
 * not even a long string. Every structural character in JSON is ASCII, and
 * UTF-8 continuation bytes always have the high bit set, so a byte-level
 * state machine can locate every token without decoding anything. That is
 * what lets a 2 GB document be indexed in constant memory.
 *
 * The output is a node table of byte offsets; text is extracted later, per
 * visible row.
 */

const CHUNK = 1 << 20;

// ASCII codes used by the scanner. A frozen object rather than a const enum,
// which `isolatedModules` forbids.
const B = {
  Tab: 9,
  LF: 10,
  CR: 13,
  Space: 32,
  Quote: 34,
  Comma: 44,
  Colon: 58,
  LBracket: 91,
  Backslash: 92,
  RBracket: 93,
  LBrace: 123,
  RBrace: 125,
} as const;

interface Frame {
  node: number;
  kind: NodeKind.Object | NodeKind.Array;
  /** Next array index, used as the synthetic key for array children. */
  nextIndex: number;
  /** Byte range of the pending object key. */
  keyStart: number;
  keyEnd: number;
}

export interface JsonParseResult {
  table: NodeTable;
  /** Set when the document is JSON Lines rather than a single value. */
  ndjson: boolean;
}

export interface JsonParseOptions {
  signal?: AbortSignal;
  /**
   * Receives the node count directly. Callers must not read the table from
   * their own scope here: this fires while the parse is still running, before
   * the awaited result has been assigned.
   */
  onProgress?: (bytesDone: number, bytesTotal: number, nodes: number) => void;
  /** Parse as JSON Lines: one value per line, wrapped in a synthetic array. */
  ndjson?: boolean;
}

export async function parseJson(source: Source, opts: JsonParseOptions = {}): Promise<JsonParseResult> {
  const table = new NodeTable(estimateNodes(source.size));
  const total = source.size;
  const stack: Frame[] = [];

  // JSON Lines has no enclosing array, so one is synthesised to give the tree
  // a single root. Its byte range spans the whole document.
  let root = -1;
  if (opts.ndjson) {
    root = table.push(NodeKind.Array, -1, 0, 0, 0, 0);
    stack.push({ node: root, kind: NodeKind.Array, nextIndex: 0, keyStart: 0, keyEnd: 0 });
  }

  let position = 0;

  while (position < total) {
    opts.signal?.throwIfAborted();
    const end = Math.min(position + CHUNK, total);
    const chunk = await source.slice(position, end, opts.signal);

    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;
      const offset = position + i;

      switch (byte) {
        case B.Space:
        case B.Tab:
        case B.CR:
          continue;

        case B.LF:
          continue;

        case B.Comma:
        case B.Colon:
          continue;

        case B.Quote: {
          // Scan to the closing quote, honouring escapes. The scan may span
          // chunks, which is why it returns a resumable position rather than
          // assuming the string ends inside this buffer.
          const stringEnd = await scanString(source, chunk, i, position, total, opts.signal);
          const frame = stack[stack.length - 1];

          if (frame?.kind === NodeKind.Object && frame.keyStart === -1) {
            // This quote opened a key, not a value.
            frame.keyStart = offset + 1;
            frame.keyEnd = stringEnd - 1;
          } else {
            const { keyStart, keyEnd } = takeKey(frame, table);
            const node = table.push(
              NodeKind.String,
              frame?.node ?? -1,
              stack.length,
              keyStart,
              keyEnd,
              offset,
            );
            table.close(node, stringEnd);
            if (node === -1) return result(table, opts);
          }

          if (stringEnd > end) {
            // The string ran past this chunk; resume scanning after it.
            position = stringEnd;
            i = chunk.length;
            continue;
          }
          i = stringEnd - position - 1;
          continue;
        }

        case B.LBrace:
        case B.LBracket: {
          if (stack.length > MAX_DEPTH) {
            throw new ViewerError('corrupt', `JSON nested deeper than ${MAX_DEPTH} levels.`, { retryable: false });
          }
          const frame = stack[stack.length - 1];
          const { keyStart, keyEnd } = takeKey(frame, table);
          const kind = byte === B.LBrace ? NodeKind.Object : NodeKind.Array;
          const node = table.push(kind, frame?.node ?? -1, stack.length, keyStart, keyEnd, offset);
          if (node === -1) return result(table, opts);
          stack.push({ node, kind, nextIndex: 0, keyStart: kind === NodeKind.Object ? -1 : 0, keyEnd: 0 });
          continue;
        }

        case B.RBrace:
        case B.RBracket: {
          const frame = stack.pop();
          if (frame) table.close(frame.node, offset + 1);
          continue;
        }

        default: {
          // A literal or a number. Both are terminated by whitespace or a
          // structural character, so the end is found by scanning forward.
          const frame = stack[stack.length - 1];
          const { keyStart, keyEnd } = takeKey(frame, table);
          const kind = literalKind(byte);
          const node = table.push(kind, frame?.node ?? -1, stack.length, keyStart, keyEnd, offset);
          if (node === -1) return result(table, opts);

          let j = i;
          while (j < chunk.length && !isTerminator(chunk[j]!)) j++;
          if (j === chunk.length && position + j < total) {
            // The token straddles the chunk boundary; finish it with a small
            // targeted read rather than growing the buffer.
            const tail = await scanLiteralTail(source, position + j, total, opts.signal);
            table.close(node, tail);
            position = tail;
            i = chunk.length;
            continue;
          }
          table.close(node, position + j);
          i = j - 1;
          continue;
        }
      }
    }

    if (position < end) position = end;
    opts.onProgress?.(position, total, table.count);
  }

  if (table.count === 0) {
    throw new ViewerError('corrupt', 'This file contains no JSON value.', { retryable: false });
  }
  // Any container still open at EOF was never closed; clamp it to the end of
  // the document so a truncated file still renders what it does contain.
  for (const frame of stack) table.close(frame.node, total);
  if (root >= 0) table.close(root, total);

  return result(table, opts);
}

function result(table: NodeTable, opts: JsonParseOptions): JsonParseResult {
  return { table, ndjson: opts.ndjson === true };
}

/** Consume the pending object key, if any, and reset it for the next pair. */
function takeKey(frame: Frame | undefined, table: NodeTable): { keyStart: number; keyEnd: number } {
  if (!frame) return { keyStart: 0, keyEnd: 0 };

  if (frame.kind === NodeKind.Object) {
    const keyStart = frame.keyStart === -1 ? 0 : frame.keyStart;
    const keyEnd = frame.keyStart === -1 ? 0 : frame.keyEnd;
    frame.keyStart = -1;
    frame.keyEnd = 0;
    return { keyStart, keyEnd };
  }

  // Array children have no textual key. The index is stored as a negative
  // sentinel in the key range, so the reader can synthesise "[3]" without
  // walking siblings to work out the position.
  void table;
  return { keyStart: -(frame.nextIndex++ + 1), keyEnd: 0 };
}

function literalKind(byte: number): NodeKind {
  // 't'/'f' -> boolean, 'n' -> null, anything else starting a token -> number.
  if (byte === 0x74 || byte === 0x66) return NodeKind.Boolean;
  if (byte === 0x6e) return NodeKind.Null;
  return NodeKind.Number;
}

function isTerminator(byte: number): boolean {
  return (
    byte === B.Space ||
    byte === B.Tab ||
    byte === B.LF ||
    byte === B.CR ||
    byte === B.Comma ||
    byte === B.RBrace ||
    byte === B.RBracket ||
    byte === B.Colon
  );
}

/**
 * Find the byte just past the closing quote of a string starting at
 * `chunk[from]`, reading further chunks if the string does not end here.
 */
async function scanString(
  source: Source,
  chunk: Uint8Array,
  from: number,
  chunkStart: number,
  total: number,
  signal?: AbortSignal,
): Promise<number> {
  let escaped = false;
  for (let i = from + 1; i < chunk.length; i++) {
    const byte = chunk[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (byte === B.Backslash) {
      escaped = true;
      continue;
    }
    if (byte === B.Quote) return chunkStart + i + 1;
  }

  // Continue past the chunk. Long strings are rare, so a simple loop of
  // follow-up reads is fine and keeps memory flat.
  let position = chunkStart + chunk.length;
  while (position < total) {
    signal?.throwIfAborted();
    const end = Math.min(position + CHUNK, total);
    const next = await source.slice(position, end, signal);
    for (let i = 0; i < next.length; i++) {
      const byte = next[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (byte === B.Backslash) {
        escaped = true;
        continue;
      }
      if (byte === B.Quote) return position + i + 1;
    }
    position = end;
  }
  return total;
}

async function scanLiteralTail(source: Source, from: number, total: number, signal?: AbortSignal): Promise<number> {
  let position = from;
  while (position < total) {
    signal?.throwIfAborted();
    const end = Math.min(position + 4096, total);
    const next = await source.slice(position, end, signal);
    for (let i = 0; i < next.length; i++) {
      if (isTerminator(next[i]!)) return position + i;
    }
    position = end;
  }
  return total;
}

/** Roughly one node per 25 bytes in typical JSON; avoids most regrowth. */
function estimateNodes(size: number): number {
  if (size <= 0) return 4096;
  return Math.max(4096, Math.min(1_000_000, Math.ceil(size / 25)));
}
