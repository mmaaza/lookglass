import { ByteWindow, NodeKind, NodeTable, PREVIEW_CHARS, truncatePreview } from './tree-model.js';

/**
 * Turns node indices into displayable text.
 *
 * Two properties matter here. First, value ranges are *clamped* before
 * reading: a single JSON string can be 50 MB, and a tree row shows 200
 * characters of it, so reading the whole range to then throw it away would
 * reintroduce exactly the memory blow-up the offset table exists to avoid.
 * Second, all ranges for a window are gathered and read together, so a
 * scattered window costs one batched read rather than one read per row.
 */

/** Worst case 4 bytes per UTF-8 character, plus room for quotes and escapes. */
const MAX_PREVIEW_BYTES = PREVIEW_CHARS * 4 + 16;

export interface RawRowText {
  index: number;
  key: string;
  /** Value text, clamped. Empty for containers, which need no read. */
  raw: string;
  /** True when the value was longer than the clamp. */
  clipped: boolean;
}

export async function collectRowText(
  table: NodeTable,
  window: ByteWindow,
  indices: number[],
  signal?: AbortSignal,
): Promise<RawRowText[]> {
  const ranges: { start: number; end: number }[] = [];
  const plan: { index: number; keyRange: number; valueRange: number; clipped: boolean }[] = [];

  for (const index of indices) {
    const keyStart = table.keyStart[index]!;
    let keyRange = -1;
    // A negative key start is an array index sentinel, not a byte offset.
    if (keyStart >= 0 && table.keyEnd[index]! > keyStart) {
      keyRange = ranges.length;
      ranges.push({ start: keyStart, end: Math.min(table.keyEnd[index]!, keyStart + MAX_PREVIEW_BYTES) });
    }

    let valueRange = -1;
    let clipped = false;
    if (!table.isContainer(index)) {
      const start = table.valueStart[index]!;
      const end = table.valueEnd[index]!;
      const clampedEnd = Math.min(end, start + MAX_PREVIEW_BYTES);
      clipped = clampedEnd < end;
      valueRange = ranges.length;
      ranges.push({ start, end: clampedEnd });
    }

    plan.push({ index, keyRange, valueRange, clipped });
  }

  const texts = await window.read(ranges, signal);

  return plan.map((entry) => ({
    index: entry.index,
    key: entry.keyRange >= 0 ? (texts[entry.keyRange] ?? '') : syntheticKey(table, entry.index),
    raw: entry.valueRange >= 0 ? (texts[entry.valueRange] ?? '') : '',
    clipped: entry.clipped,
  }));
}

/** Array children carry their position as a negative sentinel in `keyStart`. */
export function syntheticKey(table: NodeTable, index: number): string {
  const keyStart = table.keyStart[index]!;
  return keyStart < 0 ? String(-keyStart - 1) : '';
}

/* ------------------------------------------------------------------ *
 * JSON formatting
 * ------------------------------------------------------------------ */

/**
 * Decode JSON string escapes.
 *
 * Written by hand rather than via `JSON.parse` because the input is a clamped
 * fragment: a value cut mid-escape is normal here and must degrade to the
 * literal characters instead of throwing.
 */
export function unescapeJsonString(text: string): string {
  if (!text.includes('\\')) return text;

  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = text[++i];
    switch (next) {
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case '/':
        out += '/';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'u': {
        const hex = text.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
        } else {
          // Truncated at the clamp boundary; keep what is there.
          out += `\\u${hex}`;
          i += hex.length;
        }
        break;
      }
      case undefined:
        out += '\\';
        break;
      default:
        out += `\\${next}`;
        break;
    }
  }
  return out;
}

export function jsonPreview(table: NodeTable, index: number, raw: string, clipped: boolean): string {
  const kind = table.kinds[index] as NodeKind;
  const count = table.childCounts[index]!;

  switch (kind) {
    case NodeKind.Object:
      return count === 0 ? '{}' : `{ ${count} ${count === 1 ? 'key' : 'keys'} }`;
    case NodeKind.Array:
      return count === 0 ? '[]' : `[ ${count.toLocaleString()} ${count === 1 ? 'item' : 'items'} ]`;
    case NodeKind.String: {
      // Strip the surrounding quotes recorded by the scanner before unescaping.
      const inner = raw.startsWith('"') ? raw.slice(1, clipped ? undefined : -1) : raw;
      return truncatePreview(unescapeJsonString(inner)) + (clipped ? '…' : '');
    }
    default:
      return truncatePreview(raw);
  }
}

export function jsonKey(table: NodeTable, index: number, key: string): string {
  return table.keyStart[index]! < 0 ? syntheticKey(table, index) : unescapeJsonString(key);
}

/* ------------------------------------------------------------------ *
 * XML formatting
 * ------------------------------------------------------------------ */

/**
 * Decode the only entities XML guarantees, plus numeric character
 * references.
 *
 * Custom entities are deliberately left as literal text. Expanding them is
 * what makes billion-laughs and XXE possible, and a viewer showing `&foo;`
 * verbatim is a far better outcome than one that can be made to hang or to
 * exfiltrate a local file.
 */
export function decodeXmlText(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code =
          entity[1] === 'x' || entity[1] === 'X'
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        // Reject out-of-range and surrogate code points rather than throwing.
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        if (code >= 0xd800 && code <= 0xdfff) return match;
        return String.fromCodePoint(code);
      }
    }
  });
}

/** Parse an attribute span into name/value pairs. */
export function parseAttributes(text: string): [string, string][] {
  const out: [string, string][] = [];
  const pattern = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(text);
  while (match !== null) {
    out.push([match[1]!, decodeXmlText(match[3] ?? match[4] ?? '')]);
    // A row showing dozens of attributes is unreadable; the rest stay in the
    // document and are still reachable by search.
    if (out.length >= 12) break;
    match = pattern.exec(text);
  }
  return out;
}

export function xmlPreview(table: NodeTable, index: number, raw: string, clipped: boolean): string {
  const kind = table.kinds[index] as NodeKind;
  switch (kind) {
    case NodeKind.Element: {
      const count = table.childCounts[index]!;
      if (count === 0) return '';
      return `${count.toLocaleString()} ${count === 1 ? 'child' : 'children'}`;
    }
    case NodeKind.Comment:
      return truncatePreview(raw);
    case NodeKind.CData:
    case NodeKind.Text:
      return truncatePreview(decodeXmlText(raw)) + (clipped ? '…' : '');
    default:
      return truncatePreview(raw);
  }
}

/** Clip inline XML text without collapsing meaningful internal whitespace. */
export function truncateXml(text: string, limit = PREVIEW_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}
