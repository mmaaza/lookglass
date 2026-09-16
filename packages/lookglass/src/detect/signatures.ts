import type { FormatKind } from '../types.js';

export interface Signature {
  kind: FormatKind;
  mime: string;
  /** Byte pattern; `null` matches any byte at that position. */
  bytes: (number | null)[];
  offset?: number;
  label: string;
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/**
 * Binary magic numbers, checked before any extension or MIME claim.
 *
 * Order matters only where patterns overlap; ZIP and CFB are handled
 * separately because both are containers whose real type lives inside.
 */
export const SIGNATURES: Signature[] = [
  { kind: 'pdf', mime: 'application/pdf', bytes: ascii('%PDF-'), label: 'PDF document' },
  {
    kind: 'image',
    mime: 'image/png',
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    label: 'PNG image',
  },
  { kind: 'image', mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff], label: 'JPEG image' },
  { kind: 'image', mime: 'image/gif', bytes: ascii('GIF87a'), label: 'GIF image' },
  { kind: 'image', mime: 'image/gif', bytes: ascii('GIF89a'), label: 'GIF image' },
  { kind: 'image', mime: 'image/bmp', bytes: ascii('BM'), label: 'Bitmap image' },
  { kind: 'image', mime: 'image/avif', bytes: ascii('ftypavif'), offset: 4, label: 'AVIF image' },
  { kind: 'image', mime: 'image/heic', bytes: ascii('ftypheic'), offset: 4, label: 'HEIC image' },
  { kind: 'image', mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00], label: 'TIFF image' },
  { kind: 'image', mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a], label: 'TIFF image' },
  // RIFF....WEBP — the four size bytes in between are wildcards.
  {
    kind: 'image',
    mime: 'image/webp',
    bytes: [...ascii('RIFF'), null, null, null, null, ...ascii('WEBP')],
    label: 'WebP image',
  },
];

/** ZIP local file header. Every OOXML format is a ZIP underneath. */
export const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** Empty archive / spanned archive variants, still ZIP. */
export const ZIP_MAGIC_ALT = [
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];
/** Compound File Binary — legacy .doc/.xls/.ppt. */
export const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Part names that identify an OOXML package, in scan priority order. */
export const OOXML_MARKERS: { marker: string; kind: FormatKind; mime: string; label: string }[] = [
  {
    marker: 'word/document.xml',
    kind: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word document',
  },
  {
    marker: 'xl/workbook.xml',
    kind: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel workbook',
  },
  {
    marker: 'ppt/presentation.xml',
    kind: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PowerPoint presentation',
  },
  // Macro-enabled and template variants share the same primary part.
  { marker: 'xl/worksheets/', kind: 'xlsx', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12', label: 'Excel workbook' },
  { marker: 'ppt/slides/', kind: 'pptx', mime: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12', label: 'PowerPoint presentation' },
];

export const EXTENSION_MAP: Record<string, { kind: FormatKind; mime: string; label: string }> = {
  pdf: { kind: 'pdf', mime: 'application/pdf', label: 'PDF document' },
  png: { kind: 'image', mime: 'image/png', label: 'PNG image' },
  jpg: { kind: 'image', mime: 'image/jpeg', label: 'JPEG image' },
  jpeg: { kind: 'image', mime: 'image/jpeg', label: 'JPEG image' },
  webp: { kind: 'image', mime: 'image/webp', label: 'WebP image' },
  gif: { kind: 'image', mime: 'image/gif', label: 'GIF image' },
  bmp: { kind: 'image', mime: 'image/bmp', label: 'Bitmap image' },
  avif: { kind: 'image', mime: 'image/avif', label: 'AVIF image' },
  tif: { kind: 'image', mime: 'image/tiff', label: 'TIFF image' },
  tiff: { kind: 'image', mime: 'image/tiff', label: 'TIFF image' },
  svg: { kind: 'svg', mime: 'image/svg+xml', label: 'SVG image' },
  docx: {
    kind: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word document',
  },
  doc: { kind: 'doc', mime: 'application/msword', label: 'Word 97-2003 document' },
  xlsx: {
    kind: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel workbook',
  },
  xlsm: { kind: 'xlsx', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12', label: 'Excel workbook' },
  xls: { kind: 'xls', mime: 'application/vnd.ms-excel', label: 'Excel 97-2003 workbook' },
  csv: { kind: 'csv', mime: 'text/csv', label: 'CSV data' },
  tsv: { kind: 'csv', mime: 'text/tab-separated-values', label: 'TSV data' },
  pptx: {
    kind: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PowerPoint presentation',
  },
  ppt: { kind: 'ppt', mime: 'application/vnd.ms-powerpoint', label: 'PowerPoint 97-2003 presentation' },
  txt: { kind: 'text', mime: 'text/plain', label: 'Plain text' },
  log: { kind: 'text', mime: 'text/plain', label: 'Log file' },
  json: { kind: 'json', mime: 'application/json', label: 'JSON data' },
  jsonl: { kind: 'jsonl', mime: 'application/x-ndjson', label: 'JSON Lines data' },
  ndjson: { kind: 'jsonl', mime: 'application/x-ndjson', label: 'JSON Lines data' },
  xml: { kind: 'xml', mime: 'application/xml', label: 'XML document' },
  md: { kind: 'markdown', mime: 'text/markdown', label: 'Markdown document' },
  markdown: { kind: 'markdown', mime: 'text/markdown', label: 'Markdown document' },
  mdx: { kind: 'markdown', mime: 'text/markdown', label: 'MDX document' },
};

export const MIME_MAP: Record<string, FormatKind> = {
  'application/pdf': 'pdf',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/bmp': 'image',
  'image/avif': 'image',
  'image/tiff': 'image',
  'image/svg+xml': 'svg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
  'text/plain': 'text',
  'application/json': 'json',
  'application/x-ndjson': 'jsonl',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/markdown': 'markdown',
};

export function matches(head: Uint8Array, pattern: (number | null)[], offset = 0): boolean {
  if (head.length < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i];
    if (expected === null) continue;
    if (head[offset + i] !== expected) return false;
  }
  return true;
}
