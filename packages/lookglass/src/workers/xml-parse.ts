import { ViewerError } from '../core/errors.js';
import type { Source } from '../source/types.js';
import { MAX_DEPTH, NodeKind, NodeTable } from './tree-model.js';

/**
 * Streaming XML scanner.
 *
 * `DOMParser` is not an option at this size: it materialises a full DOM on
 * the main thread, and a 200 MB document is gigabytes of nodes. This is the
 * same offset-table approach as the JSON scanner, over a small buffered
 * reader so constructs that straddle chunk boundaries are handled once
 * instead of at every call site.
 *
 * Security posture — entities are **never expanded**:
 *
 *   - External entities are never fetched, so XXE is structurally impossible
 *     rather than filtered.
 *   - Internal entity declarations are detected and reported, and references
 *     render literally, so the billion-laughs expansion cannot occur.
 *
 * Only the five predefined entities and numeric character references are
 * decoded, and that happens at display time on already-clipped text.
 */

const CHUNK = 1 << 20;

const LT = 0x3c; // <
const GT = 0x3e; // >
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const QUOTE = 0x22;
const APOS = 0x27;

export interface XmlParseResult {
  table: NodeTable;
  /** Declared encoding from the XML declaration, if present. */
  encoding?: string;
  /** True when the DOCTYPE declared entities; references are left literal. */
  entitiesDeclared: boolean;
  /** Close tags that did not match the open element. */
  mismatched: number;
}

export interface XmlParseOptions {
  signal?: AbortSignal;
  /** Receives the node count directly; see `JsonParseOptions.onProgress`. */
  onProgress?: (bytesDone: number, bytesTotal: number, nodes: number) => void;
}

/** A sliding byte window; keeps exactly one chunk resident. */
class ChunkReader {
  // Explicit generic argument: `Source.slice` may return a view over a
  // SharedArrayBuffer, which the default `Uint8Array<ArrayBuffer>` rejects.
  buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  start = 0;

  constructor(
    private readonly source: Source,
    readonly total: number,
    private readonly signal?: AbortSignal,
  ) {}

  get end(): number {
    return this.start + this.buf.length;
  }

  /** Load the window containing `position`. */
  async seek(position: number): Promise<void> {
    this.signal?.throwIfAborted();
    const start = Math.min(position, this.total);
    const end = Math.min(start + CHUNK, this.total);
    this.buf = await this.source.slice(start, end, this.signal);
    this.start = start;
  }

  /** Ensure `position` is inside the window; returns false at EOF. */
  async ensure(position: number): Promise<boolean> {
    if (position >= this.total) return false;
    if (position < this.start || position >= this.end) await this.seek(position);
    return position < this.end;
  }

  at(position: number): number {
    return this.buf[position - this.start] ?? -1;
  }
}

export async function parseXml(source: Source, opts: XmlParseOptions = {}): Promise<XmlParseResult> {
  const total = source.size;
  const table = new NodeTable(Math.max(4096, Math.min(1_000_000, Math.ceil(total / 40) + 16)));
  const reader = new ChunkReader(source, total, opts.signal);

  const stack: { node: number; nameStart: number; nameEnd: number }[] = [];
  let entitiesDeclared = false;
  let mismatched = 0;
  let sawElement = false;
  let encoding: string | undefined;
  let position = 0;
  let lastProgress = 0;

  // Node 0 is a synthetic document root. A comment, PI or DOCTYPE can sit
  // beside the root element, so top-level nodes are siblings and need a
  // common parent; the tree hides this node rather than showing it as a row.
  const documentRoot = table.push(NodeKind.Document, -1, 0, 0, 0, 0);
  const currentParent = () => (stack.length > 0 ? stack[stack.length - 1]!.node : documentRoot);

  while (position < total) {
    if (!(await reader.ensure(position))) break;

    if (reader.at(position) !== LT) {
      // Text run up to the next '<'.
      const textStart = position;
      const textEnd = await findByte(reader, position, LT);
      if (!(await isWhitespaceOnly(reader, textStart, textEnd))) {
        const node = table.push(NodeKind.Text, currentParent(), stack.length, 0, 0, textStart);
        if (node === -1) break;
        table.close(node, textEnd);
      }
      position = textEnd;
      continue;
    }

    const next = (await reader.ensure(position + 1)) ? reader.at(position + 1) : -1;

    // ---- closing tag ---------------------------------------------------
    if (next === SLASH) {
      const tagEnd = await findByte(reader, position, GT);
      const frame = stack.pop();
      if (frame) {
        table.close(frame.node, Math.min(tagEnd + 1, total));
        const name = await readAscii(reader, position + 2, tagEnd);
        const openName = await readAscii(reader, frame.nameStart, frame.nameEnd);
        // Mismatches are counted, not thrown: half the XML in the wild is
        // slightly malformed and still worth showing.
        if (name.trim() !== openName) mismatched++;
      }
      position = tagEnd + 1;
      continue;
    }

    // ---- comment, CDATA, doctype --------------------------------------
    if (next === BANG) {
      const kind = await classifyBang(reader, position);

      if (kind === 'comment') {
        const inner = position + 4;
        const close = await findSequence(reader, inner, [0x2d, 0x2d, GT]); // -->
        const node = table.push(NodeKind.Comment, currentParent(), stack.length, 0, 0, inner);
        if (node === -1) break;
        table.close(node, close);
        position = Math.min(close + 3, total);
        continue;
      }

      if (kind === 'cdata') {
        const inner = position + 9;
        const close = await findSequence(reader, inner, [0x5d, 0x5d, GT]); // ]]>
        const node = table.push(NodeKind.CData, currentParent(), stack.length, 0, 0, inner);
        if (node === -1) break;
        table.close(node, close);
        position = Math.min(close + 3, total);
        continue;
      }

      // DOCTYPE or another declaration. The internal subset is skipped
      // wholesale, and any ENTITY declaration inside it is flagged.
      const declEnd = await scanDeclaration(reader, position);
      if (declEnd.hasEntities) entitiesDeclared = true;
      const node = table.push(NodeKind.Doctype, currentParent(), stack.length, 0, 0, position);
      if (node !== -1) table.close(node, declEnd.end);
      position = declEnd.end;
      continue;
    }

    // ---- processing instruction ----------------------------------------
    if (next === QUESTION) {
      const close = await findSequence(reader, position + 2, [QUESTION, GT]);
      const text = await readAscii(reader, position + 2, close);
      if (/^xml\s/i.test(text)) {
        encoding = /encoding\s*=\s*["']([^"']+)["']/i.exec(text)?.[1];
      } else {
        const node = table.push(NodeKind.Instruction, currentParent(), stack.length, 0, 0, position + 2);
        if (node !== -1) table.close(node, close);
      }
      position = Math.min(close + 2, total);
      continue;
    }

    // ---- element -------------------------------------------------------
    if (stack.length > MAX_DEPTH) {
      throw new ViewerError('corrupt', `XML nested deeper than ${MAX_DEPTH} levels.`, { retryable: false });
    }

    const nameStart = position + 1;
    const nameEnd = await findNameEnd(reader, nameStart);
    const tagEnd = await findTagEnd(reader, nameEnd);
    const selfClosing = tagEnd.selfClosing;

    const node = table.push(NodeKind.Element, currentParent(), stack.length, nameStart, nameEnd, position);
    if (node === -1) break;
    sawElement = true;
    // Attributes are stored as a span and parsed only when the row is shown.
    table.auxStart[node] = nameEnd;
    table.auxEnd[node] = tagEnd.attributesEnd;

    if (selfClosing) {
      table.close(node, Math.min(tagEnd.end + 1, total));
    } else {
      stack.push({ node, nameStart, nameEnd });
    }

    position = tagEnd.end + 1;

    if (position - lastProgress > CHUNK) {
      lastProgress = position;
      opts.onProgress?.(position, total, table.count);
    }
  }

  // Unclosed elements at EOF: clamp rather than discard.
  for (const frame of stack) table.close(frame.node, total);
  table.close(documentRoot, total);

  // A file of plain text produces a single text node and no elements. That is
  // not XML, and treating it as a one-row tree would be worse than saying so —
  // detection can then fall back to the text renderer.
  if (!sawElement) {
    throw new ViewerError('corrupt', 'This file contains no XML elements.', { retryable: false });
  }

  opts.onProgress?.(total, total, table.count);
  return { table, encoding, entitiesDeclared, mismatched };
}

/* ------------------------------ scanning ------------------------------ */

async function findByte(reader: ChunkReader, from: number, target: number): Promise<number> {
  let position = from;
  while (await reader.ensure(position)) {
    const local = reader.buf.indexOf(target, position - reader.start);
    if (local !== -1) return reader.start + local;
    position = reader.end;
  }
  return reader.total;
}

async function findSequence(reader: ChunkReader, from: number, sequence: number[]): Promise<number> {
  let position = from;
  while (await reader.ensure(position)) {
    const offset = position - reader.start;
    for (let i = offset; i <= reader.buf.length - sequence.length; i++) {
      let hit = true;
      for (let j = 0; j < sequence.length; j++) {
        if (reader.buf[i + j] !== sequence[j]) {
          hit = false;
          break;
        }
      }
      if (hit) return reader.start + i;
    }
    // Step back so a sequence straddling the boundary is not missed.
    position = Math.max(reader.end - (sequence.length - 1), position + 1);
    if (reader.end >= reader.total) break;
  }
  return reader.total;
}

/** End of an element name: whitespace, '/', or '>'. */
async function findNameEnd(reader: ChunkReader, from: number): Promise<number> {
  let position = from;
  while (await reader.ensure(position)) {
    const byte = reader.at(position);
    if (byte <= 0x20 || byte === SLASH || byte === GT) return position;
    position++;
  }
  return reader.total;
}

/**
 * End of a start tag, respecting quoted attribute values.
 *
 * Attribute values legitimately contain '>', so scanning for the next '>'
 * without tracking quotes truncates tags — a common and very confusing bug.
 */
async function findTagEnd(
  reader: ChunkReader,
  from: number,
): Promise<{ end: number; selfClosing: boolean; attributesEnd: number }> {
  let position = from;
  let quote = 0;
  let lastNonSpace = from;

  while (await reader.ensure(position)) {
    const byte = reader.at(position);

    if (quote !== 0) {
      if (byte === quote) quote = 0;
      position++;
      continue;
    }

    if (byte === QUOTE || byte === APOS) {
      quote = byte;
      position++;
      continue;
    }

    if (byte === GT) {
      const selfClosing = reader.at(lastNonSpace) === SLASH;
      return { end: position, selfClosing, attributesEnd: selfClosing ? lastNonSpace : position };
    }

    if (byte > 0x20) lastNonSpace = position;
    position++;
  }

  return { end: reader.total, selfClosing: false, attributesEnd: reader.total };
}

async function classifyBang(reader: ChunkReader, position: number): Promise<'comment' | 'cdata' | 'declaration'> {
  const head = await readAscii(reader, position, Math.min(position + 9, reader.total));
  if (head.startsWith('<!--')) return 'comment';
  if (head.startsWith('<![CDATA[')) return 'cdata';
  return 'declaration';
}

/**
 * Skip a DOCTYPE, including any internal subset, and report whether it
 * declared entities.
 */
async function scanDeclaration(reader: ChunkReader, from: number): Promise<{ end: number; hasEntities: boolean }> {
  let position = from;
  let depth = 0;
  let quote = 0;
  let hasEntities = false;
  const probe = (await readAscii(reader, from, Math.min(from + 4096, reader.total))).toUpperCase();
  if (probe.includes('<!ENTITY')) hasEntities = true;

  while (await reader.ensure(position)) {
    const byte = reader.at(position);
    if (quote !== 0) {
      if (byte === quote) quote = 0;
    } else if (byte === QUOTE || byte === APOS) {
      quote = byte;
    } else if (byte === 0x5b) {
      depth++;
    } else if (byte === 0x5d) {
      depth--;
    } else if (byte === GT && depth <= 0) {
      return { end: position + 1, hasEntities };
    }
    position++;
  }
  return { end: reader.total, hasEntities };
}

async function isWhitespaceOnly(reader: ChunkReader, from: number, to: number): Promise<boolean> {
  // Only inspect the head: a long run that starts with real text is not
  // whitespace, and a long run of pure whitespace is vanishingly rare.
  const limit = Math.min(to, from + 4096);
  let position = from;
  while (position < limit && (await reader.ensure(position))) {
    if (reader.at(position) > 0x20) return false;
    position++;
  }
  return to - from <= 4096;
}

async function readAscii(reader: ChunkReader, from: number, to: number): Promise<string> {
  const end = Math.min(to, reader.total);
  if (end <= from) return '';
  // Bounded by design: names, tags and declaration heads are all short.
  const length = Math.min(end - from, 4096);
  let out = '';
  for (let position = from; position < from + length; position++) {
    if (!(await reader.ensure(position))) break;
    out += String.fromCharCode(reader.at(position));
  }
  return out;
}
