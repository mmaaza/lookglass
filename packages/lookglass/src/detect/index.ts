import type { Source } from '../source/types.js';
import { isCodeExtension } from '../core/languages.js';
import type { DetectedFormat, FormatKind } from '../types.js';
import {
  CFB_MAGIC,
  EXTENSION_MAP,
  MIME_MAP,
  OOXML_MARKERS,
  SIGNATURES,
  ZIP_MAGIC,
  ZIP_MAGIC_ALT,
  matches,
} from './signatures.js';

export * from './signatures.js';

const HEAD_BYTES = 8192;
/** ZIP central directory lives at the end; part names are stored there too. */
const TAIL_BYTES = 65536;

export interface DetectOptions {
  /** Filename to use for the extension hint. Defaults to `source.name`. */
  name?: string;
  /** Declared MIME. Defaults to `source.mimeHint`. Treated as a weak signal. */
  mime?: string;
  signal?: AbortSignal;
}

/**
 * Identify a document from its bytes first, its declared type second, and its
 * extension last.
 *
 * Extensions and MIME types are wrong often enough to matter in production:
 * `.xls` files that are really HTML tables, `.docx` that are really legacy
 * CFB `.doc`, and downloads with no extension at all. When the bytes disagree
 * with the claim we follow the bytes and report the disagreement in
 * `mismatch`, so the UI can say so rather than silently mis-rendering.
 */
export async function detectFormat(source: Source, opts: DetectOptions = {}): Promise<DetectedFormat> {
  const name = opts.name ?? source.name;
  const claimedMime = normaliseMime(opts.mime ?? source.mimeHint);
  const ext = extensionOf(name);

  const headLength = source.size >= 0 ? Math.min(HEAD_BYTES, source.size) : HEAD_BYTES;
  const head = headLength > 0 ? await source.slice(0, headLength, opts.signal) : new Uint8Array(0);

  const fromBytes = await detectFromBytes(source, head, ext, opts.signal);
  if (fromBytes) {
    return withMismatch(fromBytes, claimedMime, ext);
  }

  // No binary signature. Text formats are distinguished by content shape,
  // with the extension acting as a tie-breaker rather than the decision.
  const text = decodeHead(head);
  if (text !== undefined) {
    const fromText = detectFromText(text, ext, source.size);
    if (fromText) return withMismatch(fromText, claimedMime, ext);
  }

  if (claimedMime && MIME_MAP[claimedMime]) {
    const kind = MIME_MAP[claimedMime]!;
    return {
      kind,
      mime: claimedMime,
      ext,
      confidence: 0.5,
      method: 'mime',
      label: labelFor(kind),
    };
  }

  if (ext && EXTENSION_MAP[ext]) {
    const entry = EXTENSION_MAP[ext]!;
    return { kind: entry.kind, mime: entry.mime, ext, confidence: 0.4, method: 'extension', label: entry.label };
  }

  return {
    kind: 'unknown',
    mime: claimedMime ?? 'application/octet-stream',
    ext,
    confidence: 0,
    method: 'fallback',
    label: 'Unrecognised file',
  };
}

async function detectFromBytes(
  source: Source,
  head: Uint8Array,
  ext: string | undefined,
  signal?: AbortSignal,
): Promise<DetectedFormat | undefined> {
  for (const signature of SIGNATURES) {
    if (matches(head, signature.bytes, signature.offset ?? 0)) {
      return {
        kind: signature.kind,
        mime: signature.mime,
        ext,
        confidence: 0.99,
        method: 'magic',
        label: signature.label,
      };
    }
  }

  const isZip =
    matches(head, ZIP_MAGIC) || ZIP_MAGIC_ALT.some((pattern) => matches(head, pattern));

  if (isZip) {
    const inner = await identifyOoxml(source, head, signal);
    if (inner) return { ...inner, ext, confidence: 0.97, method: 'container' };
    return {
      kind: 'unknown',
      mime: 'application/zip',
      ext,
      confidence: 0.6,
      method: 'container',
      label: 'ZIP archive',
    };
  }

  if (matches(head, CFB_MAGIC)) {
    // A CFB container needs its directory parsed to know which Office app
    // wrote it. We do not ship a CFB parser in core, so the extension picks
    // the variant — and all three variants are legacy formats we only
    // recognise in order to give a useful "not supported" message.
    const kind: FormatKind = ext === 'xls' ? 'xls' : ext === 'ppt' ? 'ppt' : 'doc';
    return {
      kind,
      mime: EXTENSION_MAP[ext ?? 'doc']?.mime ?? 'application/x-cfb',
      ext,
      confidence: ext ? 0.85 : 0.6,
      method: 'container',
      label: labelFor(kind),
    };
  }

  return undefined;
}

/**
 * Find the OOXML flavour by scanning for known part names.
 *
 * Local file headers store names uncompressed, and Office writes
 * `[Content_Types].xml` plus the primary part near the front, so a head scan
 * almost always succeeds. The tail scan covers packages written by other
 * tools that order entries differently, by reading the central directory.
 */
async function identifyOoxml(
  source: Source,
  head: Uint8Array,
  signal?: AbortSignal,
): Promise<{ kind: FormatKind; mime: string; label: string } | undefined> {
  const fromHead = scanForMarkers(head);
  if (fromHead) return fromHead;

  if (source.size > head.length) {
    const start = Math.max(0, source.size - TAIL_BYTES);
    const tail = await source.slice(start, source.size, signal);
    const fromTail = scanForMarkers(tail);
    if (fromTail) return fromTail;
  }

  return undefined;
}

function scanForMarkers(bytes: Uint8Array): { kind: FormatKind; mime: string; label: string } | undefined {
  // Latin-1 keeps byte offsets aligned with characters, which matters because
  // compressed data between names can contain arbitrary bytes.
  const text = latin1(bytes);
  for (const { marker, kind, mime, label } of OOXML_MARKERS) {
    if (text.includes(marker)) return { kind, mime, label };
  }
  return undefined;
}

function detectFromText(text: string, ext: string | undefined, size: number): DetectedFormat | undefined {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) {
    return { kind: 'text', mime: 'text/plain', ext, confidence: 0.6, method: 'content', label: 'Empty file' };
  }

  // A known source extension on text content is source code. Checked before
  // the content heuristics because code trips all of them: Python and shell
  // comments look like Markdown headings, and argument lists look like CSV.
  if (isCodeExtension(ext)) {
    return { kind: 'text', mime: 'text/plain', ext, confidence: 0.9, method: 'extension', label: 'Source code' };
  }

  if (/^<\?xml/i.test(trimmed) || /^<svg[\s>]/i.test(trimmed)) {
    const isSvg = /<svg[\s>]/i.test(trimmed.slice(0, 2048));
    return isSvg
      ? { kind: 'svg', mime: 'image/svg+xml', ext, confidence: 0.95, method: 'content', label: 'SVG image' }
      : { kind: 'xml', mime: 'application/xml', ext, confidence: 0.9, method: 'content', label: 'XML document' };
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // JSON Lines looks like JSON at the first character but has one complete
    // object per line, so check that before committing to a single document.
    if (looksLikeJsonLines(trimmed)) {
      return {
        kind: 'jsonl',
        mime: 'application/x-ndjson',
        ext,
        confidence: 0.85,
        method: 'content',
        label: 'JSON Lines data',
      };
    }
    // A head-only sample cannot be fully parsed, so confidence stays below 1
    // unless the whole file fit in the sample and parsed cleanly.
    const whole = size >= 0 && size <= text.length;
    const valid = whole ? isParseableJson(trimmed) : true;
    if (valid) {
      return {
        kind: 'json',
        mime: 'application/json',
        ext,
        confidence: whole ? 0.99 : 0.85,
        method: 'content',
        label: 'JSON data',
      };
    }
  }

  // Markdown is a superset of plain text, so only claim it when the extension
  // agrees or the structure is unambiguous.
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') {
    return { kind: 'markdown', mime: 'text/markdown', ext, confidence: 0.9, method: 'extension', label: 'Markdown document' };
  }
  if (looksLikeMarkdown(trimmed)) {
    return { kind: 'markdown', mime: 'text/markdown', ext, confidence: 0.7, method: 'content', label: 'Markdown document' };
  }

  const delimiter = sniffDelimiter(text);
  if (delimiter) {
    return {
      kind: 'csv',
      mime: delimiter === '\t' ? 'text/tab-separated-values' : 'text/csv',
      ext,
      confidence: ext === 'csv' || ext === 'tsv' ? 0.95 : 0.75,
      method: 'content',
      label: delimiter === '\t' ? 'TSV data' : 'CSV data',
    };
  }

  return { kind: 'text', mime: 'text/plain', ext, confidence: 0.7, method: 'content', label: 'Plain text' };
}

/* ------------------------------ helpers ------------------------------ */

/**
 * Decode a head sample as text, or return undefined when it is binary.
 *
 * A NUL byte in the first few kB is the cheapest reliable binary signal;
 * real-world text files essentially never contain one, and UTF-16 text is
 * excluded here on purpose because its BOM is handled below.
 */
function decodeHead(head: Uint8Array): string | undefined {
  if (head.length === 0) return '';

  if (head[0] === 0xff && head[1] === 0xfe) return decode(head.subarray(2), 'utf-16le');
  if (head[0] === 0xfe && head[1] === 0xff) return decode(head.subarray(2), 'utf-16be');
  const bodyStart = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;

  const scanLength = Math.min(head.length, 4096);
  for (let i = bodyStart; i < scanLength; i++) {
    if (head[i] === 0x00) return undefined;
  }

  try {
    // `fatal` rejects invalid UTF-8, which is a strong signal the file is not
    // text at all. A truncated multi-byte char at the sample edge is trimmed
    // first so a valid file is not misread as binary.
    return new TextDecoder('utf-8', { fatal: true }).decode(trimPartialCodepoint(head.subarray(bodyStart)));
  } catch {
    // Still plausibly text in a legacy single-byte encoding.
    return decode(head.subarray(bodyStart), 'windows-1252');
  }
}

function decode(bytes: Uint8Array, encoding: string): string | undefined {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Drop up to 3 trailing bytes that could be a split UTF-8 sequence. */
function trimPartialCodepoint(bytes: Uint8Array): Uint8Array {
  for (let back = 1; back <= 3 && back <= bytes.length; back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return out;
}

function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function looksLikeJsonLines(text: string): boolean {
  const lines = text.split('\n').slice(0, 5).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;
  return lines.every((line) => {
    const value = line.trim();
    return value.startsWith('{') && value.endsWith('}') && isParseableJson(value);
  });
}

function looksLikeMarkdown(text: string): boolean {
  const sample = text.slice(0, 4096);
  let score = 0;
  if (/^#{1,6}\s+\S/m.test(sample)) score += 2;
  if (/^\s*[-*+]\s+\S/m.test(sample)) score += 1;
  if (/\[[^\]]+\]\([^)]+\)/.test(sample)) score += 2;
  if (/^```/m.test(sample)) score += 2;
  if (/^>\s+\S/m.test(sample)) score += 1;
  if (/\*\*\S[^*]*\*\*/.test(sample)) score += 1;
  if (/^\|.+\|\s*$/m.test(sample)) score += 1;
  return score >= 3;
}

/**
 * Detect a delimiter by requiring a *consistent* field count across lines.
 * Counting occurrences alone misfires on prose containing commas.
 */
function sniffDelimiter(text: string): string | undefined {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 12);
  if (lines.length < 2) return undefined;

  let best: { delimiter: string; fields: number } | undefined;
  for (const delimiter of [',', '\t', ';', '|']) {
    const counts = lines.map((line) => countFields(line, delimiter));
    const first = counts[0]!;
    if (first < 2) continue;
    const consistent = counts.every((count) => count === first);
    if (consistent && (!best || first > best.fields)) best = { delimiter, fields: first };
  }
  return best?.delimiter;
}

/** Field count that respects double-quoted sections. */
function countFields(line: string, delimiter: string): number {
  let fields = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      fields++;
    }
  }
  return fields;
}

function withMismatch(
  result: DetectedFormat,
  claimedMime: string | undefined,
  ext: string | undefined,
): DetectedFormat {
  const claimedKind = claimedMime ? MIME_MAP[claimedMime] : ext ? EXTENSION_MAP[ext]?.kind : undefined;
  if (!claimedKind || claimedKind === result.kind) return result;
  // Legacy/modern pairs are a common benign mismatch (a .doc that is really a
  // .docx); still report it, but it is not a corruption signal.
  return {
    ...result,
    mismatch: { claimed: claimedMime ?? ext ?? 'unknown', actual: result.kind },
  };
}

export function extensionOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const clean = name.split(/[?#]/)[0] ?? name;
  const index = clean.lastIndexOf('.');
  if (index <= 0 || index === clean.length - 1) return undefined;
  return clean.slice(index + 1).toLowerCase();
}

function normaliseMime(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const value = mime.split(';')[0]?.trim().toLowerCase();
  return value && value !== 'application/octet-stream' && value !== 'binary/octet-stream' ? value : undefined;
}

export function labelFor(kind: FormatKind): string {
  for (const entry of Object.values(EXTENSION_MAP)) {
    if (entry.kind === kind) return entry.label;
  }
  return 'Unrecognised file';
}
