/// <reference lib="webworker" />
import { exposeRpc, type RpcContext } from '../core/rpc.js';
import { sourceFromDescriptor } from '../source/index.js';
import type { Source, SourceDescriptor } from '../source/types.js';
import type { SearchHit } from '../types.js';

/**
 * Line-offset indexer for text and code.
 *
 * The worker is the data server: it holds the byte offsets of every line and
 * hands the UI only the window it is about to paint. A 4 GB log costs the
 * same React memory as a 4 KB one, and the only state that grows with file
 * size is a Uint32Array of newline positions (4 bytes per line).
 *
 * Decoding is incremental with `TextDecoder({ stream: true })` so multi-byte
 * characters that straddle a chunk boundary are handled correctly — reading
 * fixed-size slices and decoding each independently corrupts every non-ASCII
 * document, which is the classic bug here.
 */

const CHUNK_BYTES = 4 * 1024 * 1024;
/** 4 bytes/line: 40 M lines = 160 MB of index, which is already too much. */
const MAX_LINES = 40_000_000;
const MAX_LINE_CHARS = 20_000;
const SEARCH_HIT_LIMIT = 5_000;

interface TextState {
  source: Source;
  /** Byte offset of the first character of each line. */
  offsets: Uint32Array;
  lineCount: number;
  byteLength: number;
  encoding: string;
  truncated: boolean;
  /** Byte offset where indexing stopped (== byteLength unless truncated). */
  indexedBytes: number;
}

let state: TextState | undefined;

export interface OpenTextArgs {
  descriptor: SourceDescriptor;
  encoding?: string;
}

export interface OpenTextResult {
  lineCount: number;
  byteLength: number;
  encoding: string;
  truncated: boolean;
  indexedBytes: number;
}

export interface GetLinesArgs {
  start: number;
  end: number;
}

export interface SearchArgs {
  query: string;
  caseSensitive?: boolean;
  limit?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
}

const handlers = {
  async open(args: OpenTextArgs, ctx: RpcContext): Promise<OpenTextResult> {
    const source = sourceFromDescriptor(args.descriptor);
    const encoding = args.encoding ?? (await sniffEncoding(source));
    const byteLength = source.size;

    // Growable offset index. Starting from a size estimate avoids most of the
    // reallocation churn on large files (~40 bytes per line is typical).
    let capacity = Math.max(1024, Math.min(MAX_LINES, Math.ceil(byteLength / 40) + 16));
    let offsets = new Uint32Array(capacity);
    let lineCount = 0;
    let truncated = false;

    const push = (offset: number) => {
      if (lineCount >= MAX_LINES) {
        truncated = true;
        return false;
      }
      if (lineCount >= capacity) {
        capacity = Math.min(MAX_LINES, capacity * 2);
        const grown = new Uint32Array(capacity);
        grown.set(offsets);
        offsets = grown;
      }
      offsets[lineCount++] = offset;
      return true;
    };

    push(skipBom(await source.slice(0, Math.min(4, byteLength), ctx.signal)));

    let position = 0;
    let indexedBytes = byteLength;

    while (position < byteLength) {
      ctx.signal.throwIfAborted();
      const end = Math.min(position + CHUNK_BYTES, byteLength);
      const chunk = await source.slice(position, end, ctx.signal);

      // Newline scanning happens on raw bytes, not decoded text: 0x0A cannot
      // appear inside a multi-byte UTF-8 sequence, so this is both correct
      // and far faster than decoding first.
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0a) {
          if (!push(position + i + 1)) {
            indexedBytes = position + i + 1;
            break;
          }
        }
      }

      if (truncated) break;
      position = end;
      ctx.progress({
        phase: 'indexing',
        bytesDone: position,
        bytesTotal: byteLength,
        ratio: byteLength > 0 ? position / byteLength : 1,
        message: `Indexing — ${lineCount.toLocaleString()} lines`,
      });
    }

    // A trailing newline produces a final empty line entry; drop it so line
    // counts match what every editor reports.
    if (lineCount > 1 && offsets[lineCount - 1] === indexedBytes) lineCount--;

    state = {
      source,
      offsets: offsets.subarray(0, lineCount),
      lineCount,
      byteLength,
      encoding,
      truncated,
      indexedBytes,
    };

    return { lineCount, byteLength, encoding, truncated, indexedBytes };
  },

  /**
   * Decode one window of lines. Cost is proportional to the window, never to
   * the file, because the byte range comes straight from the index.
   */
  async getLines(args: GetLinesArgs, ctx: RpcContext): Promise<string[]> {
    const current = requireState();
    const start = Math.max(0, Math.min(args.start, current.lineCount));
    const end = Math.max(start, Math.min(args.end, current.lineCount));
    if (start === end) return [];

    const byteStart = current.offsets[start] ?? 0;
    const byteEnd = end < current.lineCount ? (current.offsets[end] ?? current.indexedBytes) : current.indexedBytes;

    const bytes = await current.source.slice(byteStart, byteEnd, ctx.signal);
    const text = new TextDecoder(current.encoding, { fatal: false }).decode(bytes);

    const lines = text.split('\n');
    // `split` leaves a trailing empty element when the window ends on a
    // newline; that element belongs to the next window, not this one.
    if (lines.length > end - start) lines.length = end - start;

    return lines.map((line) => {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      // One pathological long line must not lock up the main thread when it
      // is laid out, so hard-truncate for display.
      return clean.length > MAX_LINE_CHARS ? `${clean.slice(0, MAX_LINE_CHARS)}…` : clean;
    });
  },

  /**
   * Streaming substring search over the raw file.
   *
   * Hits are emitted through `ctx.progress` as they are found so the first
   * results appear immediately on a multi-gigabyte file instead of after a
   * full scan.
   */
  async search(args: SearchArgs, ctx: RpcContext): Promise<SearchResult> {
    const current = requireState();
    const limit = args.limit ?? SEARCH_HIT_LIMIT;
    const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
    if (needle.length === 0) return { hits: [], truncated: false };

    const decoder = new TextDecoder(current.encoding, { fatal: false });
    const hits: SearchHit[] = [];
    // Overlap successive chunks so a match spanning the boundary is not lost.
    const overlap = Math.min(1024, needle.length * 4);
    let position = 0;
    let carry = '';
    let carryOffset = 0;

    while (position < current.indexedBytes && hits.length < limit) {
      ctx.signal.throwIfAborted();
      const end = Math.min(position + CHUNK_BYTES, current.indexedBytes);
      const bytes = await current.source.slice(position, end, ctx.signal);
      const decoded = decoder.decode(bytes, { stream: end < current.indexedBytes });
      const haystackRaw = carry + decoded;
      const haystack = args.caseSensitive ? haystackRaw : haystackRaw.toLowerCase();

      let index = haystack.indexOf(needle);
      while (index !== -1 && hits.length < limit) {
        // Character offsets are approximate for non-ASCII text; they are used
        // only to pick the line, and the line itself is exact.
        const absolute = carryOffset + index;
        const line = lineForCharOffset(current, absolute);
        hits.push({
          id: `${line}:${absolute}`,
          page: line + 1,
          excerpt: excerptAround(haystackRaw, index, needle.length),
          excerptOffset: Math.min(index, 40),
          excerptLength: needle.length,
        });
        index = haystack.indexOf(needle, index + needle.length);
      }

      ctx.progress({
        phase: 'indexing',
        bytesDone: end,
        bytesTotal: current.indexedBytes,
        ratio: end / current.indexedBytes,
        message: `${hits.length} matches`,
      });

      carry = haystackRaw.slice(Math.max(0, haystackRaw.length - overlap));
      carryOffset += haystackRaw.length - carry.length;
      position = end;
    }

    return { hits, truncated: hits.length >= limit };
  },

  close(): void {
    state?.source.dispose();
    state = undefined;
  },
};

export type TextWorkerHandlers = typeof handlers;

function requireState(): TextState {
  if (!state) throw new Error('Text document is not open.');
  return state;
}

/**
 * Map a character offset to a line index.
 *
 * Byte and character offsets coincide for ASCII and diverge for multi-byte
 * text; since this only drives which line to scroll to, the small drift on
 * non-ASCII documents is acceptable and bounded by the search chunk size.
 */
function lineForCharOffset(current: TextState, offset: number): number {
  let low = 0;
  let high = current.lineCount - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((current.offsets[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).replace(/\s+/g, ' ');
}

function skipBom(head: Uint8Array): number {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 3;
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return 2;
  return 0;
}

async function sniffEncoding(source: Source): Promise<string> {
  const head = await source.slice(0, Math.min(4096, source.size));
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - 3));
    return 'utf-8';
  } catch {
    // Not valid UTF-8; the overwhelmingly common alternative in the wild.
    return 'windows-1252';
  }
}

exposeRpc(handlers as never);
