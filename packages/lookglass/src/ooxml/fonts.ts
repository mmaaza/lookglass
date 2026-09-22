/**
 * Fonts for the layout engine.
 *
 * Two different things matter, and they fail differently:
 *
 *  - **Advance widths** decide where lines break. They come from whatever
 *    font the browser actually renders with, measured on a canvas, so a
 *    substituted font changes line breaks — unavoidably, unless the
 *    substitute is metric-compatible (Carlito for Calibri and so on).
 *  - **Vertical metrics** decide line heights, and so where *pages* break.
 *    These must be Word's, not the substitute's: Word's "single" line
 *    height for Calibri 11 pt is 13.43 pt whatever font the reader has. The
 *    table below records them for the fonts Office documents use most, and
 *    embedded fonts are measured from their own tables.
 */

export interface FontMetrics {
  /** Distances in em units (1 = the font size). */
  ascent: number;
  descent: number;
  lineGap: number;
}

/**
 * hhea metrics (ascender, descender, line gap) of common Office fonts, as
 * fractions of the em. Word's single line height is their sum. Families
 * designed as metric-compatible substitutes share their original's entry.
 */
const KNOWN_METRICS: Record<string, FontMetrics> = {};
function known(names: string[], unitsPerEm: number, ascender: number, descender: number, lineGap: number) {
  for (const name of names) {
    KNOWN_METRICS[name] = { ascent: ascender / unitsPerEm, descent: descender / unitsPerEm, lineGap: lineGap / unitsPerEm };
  }
}
known(['calibri', 'calibri light', 'carlito'], 2048, 1536, 512, 452);
known(['times new roman', 'tinos', 'liberation serif'], 2048, 1825, 443, 87);
known(['arial', 'arimo', 'liberation sans', 'helvetica'], 2048, 1854, 434, 67);
known(['courier new', 'cousine', 'liberation mono'], 2048, 1705, 615, 0);
known(['georgia'], 2048, 1878, 449, 0);
known(['verdana'], 2048, 2059, 430, 0);
known(['tahoma'], 2048, 2049, 423, 0);
known(['segoe ui'], 2048, 2210, 514, 0);
known(['trebuchet ms'], 2048, 1923, 455, 0);

export function knownMetrics(family: string): FontMetrics | undefined {
  return KNOWN_METRICS[family.toLowerCase()];
}

/** Metrics from a TrueType/OpenType file's `head` and `hhea` tables. */
export function parseFontMetrics(bytes: Uint8Array): FontMetrics | undefined {
  if (bytes.byteLength < 12) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint32(0);
  // TrueType (0x00010000), 'true', or CFF-based 'OTTO'.
  if (tag !== 0x00010000 && tag !== 0x74727565 && tag !== 0x4f54544f) return undefined;
  const tables = new Map<string, number>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    if (record + 16 > bytes.byteLength) return undefined;
    const name = String.fromCharCode(bytes[record]!, bytes[record + 1]!, bytes[record + 2]!, bytes[record + 3]!);
    tables.set(name, view.getUint32(record + 8));
  }
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  if (head === undefined || hhea === undefined || head + 20 > bytes.byteLength || hhea + 10 > bytes.byteLength) return undefined;
  const unitsPerEm = view.getUint16(head + 18);
  if (!unitsPerEm) return undefined;
  const ascender = view.getInt16(hhea + 4);
  const descender = view.getInt16(hhea + 6);
  const lineGap = view.getInt16(hhea + 8);
  return { ascent: ascender / unitsPerEm, descent: Math.abs(descender) / unitsPerEm, lineGap: Math.max(0, lineGap) / unitsPerEm };
}

/**
 * Undo the obfuscation Word applies to embedded fonts (ECMA-376 Part 2,
 * 17.8.1): the first 32 bytes are XORed with the font key GUID, reversed.
 */
export function deobfuscateFont(bytes: Uint8Array, fontKey: string): Uint8Array {
  const hex = fontKey.replace(/[{}-]/g, '');
  if (hex.length !== 32) return bytes;
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) key[i] = Number.parseInt(hex.slice(30 - i * 2, 32 - i * 2), 16);
  const out = bytes.slice();
  for (let i = 0; i < 32 && i < out.length; i++) out[i] = out[i]! ^ key[i % 16]!;
  return out;
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

export type GenericFamily = 'serif' | 'sans-serif' | 'monospace';

export interface FontFaceSource {
  family: string;
  weight: 'normal' | 'bold';
  style: 'normal' | 'italic';
  /** Font file bytes (embedded fonts) or a URL (bundled fonts). */
  data: Uint8Array | string;
}

export interface ResolvedFont {
  /** CSS font-family list, quoted, ending with a generic family. */
  css: string;
  /** Word's vertical metrics for the *requested* family where known. */
  metrics?: FontMetrics;
  /** The family actually used for rendering. */
  rendered: string;
  substituted: boolean;
}

/**
 * Substitutes, in preference order. Metric-compatible families first: with
 * one of those installed or bundled, text wraps exactly where Word wraps it.
 */
const SUBSTITUTES: Record<string, string[]> = {
  calibri: ['Carlito'],
  'calibri light': ['Carlito'],
  cambria: ['Caladea'],
  'cambria math': ['Cambria', 'Caladea', 'STIX Two Math'],
  arial: ['Liberation Sans', 'Arimo', 'Helvetica', 'Helvetica Neue'],
  helvetica: ['Arial', 'Liberation Sans', 'Arimo'],
  'times new roman': ['Liberation Serif', 'Tinos', 'Times'],
  times: ['Times New Roman', 'Liberation Serif', 'Tinos'],
  'courier new': ['Liberation Mono', 'Cousine', 'Courier'],
  aptos: ['Segoe UI', 'Carlito', 'Calibri'],
  'segoe ui': ['system-ui'],
  georgia: ['Gelasio'],
  'book antiqua': ['Palatino Linotype', 'Palatino'],
  'palatino linotype': ['Book Antiqua', 'Palatino'],
};

const GENERIC_BY_NAME: Array<[RegExp, GenericFamily]> = [
  [/mono|courier|consol|code/i, 'monospace'],
  [/times|roman|serif|cambria|georgia|garamond|antiqua|palatino|minion|baskerville|mincho|song|ming|batang|cardo/i, 'serif'],
];

export function genericFor(family: string, hint?: string): GenericFamily {
  // fontTable.xml's w:family classifies each font.
  if (hint === 'roman') return 'serif';
  if (hint === 'modern') return 'monospace';
  if (hint === 'swiss') return 'sans-serif';
  for (const [pattern, generic] of GENERIC_BY_NAME) if (pattern.test(family) && !/sans/i.test(family)) return generic;
  return 'sans-serif';
}

export interface FontInfo {
  /** `w:family` from the font table: roman, swiss, modern, script, decorative. */
  family?: string;
  altName?: string;
}

/**
 * Decides which installed or supplied face renders each requested family.
 * Runs in the layout worker; `installed` is checked with canvas measurement,
 * which works for system fonts in workers too.
 */
export class FontResolver {
  private readonly available = new Map<string, FontMetrics | undefined>();
  private readonly installedCache = new Map<string, boolean>();
  private readonly resolved = new Map<string, ResolvedFont>();
  private readonly isInstalledProbe: (family: string) => boolean;
  private readonly info: Map<string, FontInfo>;

  constructor(opts: { isInstalled: (family: string) => boolean; fontTable?: Map<string, FontInfo> }) {
    this.isInstalledProbe = opts.isInstalled;
    this.info = opts.fontTable ?? new Map();
  }

  /** A face that is loaded and ready (embedded or bundled). */
  addFace(family: string, metrics?: FontMetrics): void {
    const key = family.toLowerCase();
    if (!this.available.has(key) || metrics) this.available.set(key, metrics);
    this.resolved.clear();
  }

  resolve(family: string | undefined): ResolvedFont {
    const requested = (family ?? '').trim() || 'Calibri';
    const cached = this.resolved.get(requested);
    if (cached) return cached;

    const key = requested.toLowerCase();
    const info = this.info.get(key);
    const generic = genericFor(requested, info?.family);
    const metrics = this.available.get(key) ?? knownMetrics(requested);

    const candidates = [requested, ...(info?.altName ? [info.altName] : []), ...(SUBSTITUTES[key] ?? [])];
    let rendered: string | undefined;
    for (const candidate of candidates) {
      if (candidate === 'system-ui' || this.available.has(candidate.toLowerCase()) || this.installed(candidate)) {
        rendered = candidate;
        break;
      }
    }
    const result: ResolvedFont = {
      css: rendered ? `${quote(rendered)}, ${generic}` : generic,
      metrics: metrics ?? (rendered ? (this.available.get(rendered.toLowerCase()) ?? knownMetrics(rendered)) : undefined),
      rendered: rendered ?? generic,
      substituted: rendered?.toLowerCase() !== key,
    };
    this.resolved.set(requested, result);
    return result;
  }

  private installed(family: string): boolean {
    const key = family.toLowerCase();
    let value = this.installedCache.get(key);
    if (value === undefined) {
      value = this.isInstalledProbe(family);
      this.installedCache.set(key, value);
    }
    return value;
  }
}

export function quote(family: string): string {
  if (family === 'system-ui' || /^(?:serif|sans-serif|monospace)$/.test(family)) return family;
  return `"${family.replace(/["\\]/g, '')}"`;
}

/**
 * Whether a font family is installed, by comparing its text width with the
 * width of generic fallbacks. If the family is missing, the browser falls
 * back and the widths match a generic family exactly.
 */
export function createInstalledProbe(context: {
  font: string;
  measureText(text: string): { width: number };
}): (family: string) => boolean {
  const sample = 'mmmmmmmmmmlliWW@#0123456789';
  const baselines = new Map<string, number>();
  for (const generic of ['monospace', 'serif', 'sans-serif']) {
    context.font = `72px ${generic}`;
    baselines.set(generic, context.measureText(sample).width);
  }
  return (family) => {
    for (const generic of ['monospace', 'serif', 'sans-serif']) {
      context.font = `72px ${quote(family)}, ${generic}`;
      if (Math.abs(context.measureText(sample).width - baselines.get(generic)!) > 0.01) return true;
    }
    return false;
  };
}
