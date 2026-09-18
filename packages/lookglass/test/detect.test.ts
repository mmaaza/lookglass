import { describe, expect, it } from 'vitest';
import { detectFormat } from '../src/detect/index.js';
import { blobSource, memorySource } from '../src/source/index.js';

function fromBytes(bytes: number[] | Uint8Array, name: string, mime?: string) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return blobSource(new Blob([data.slice().buffer], mime ? { type: mime } : undefined), name);
}

function fromText(text: string, name: string, mime?: string) {
  return fromBytes(new TextEncoder().encode(text), name, mime);
}

/** Minimal but structurally valid ZIP containing one stored entry name. */
function zipWithEntry(entryName: string): Uint8Array {
  const name = new TextEncoder().encode(entryName);
  const header = new Uint8Array(30 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true); // local file header signature
  view.setUint16(26, name.length, true); // file name length
  header.set(name, 30);
  return header;
}

describe('detectFormat', () => {
  it('identifies PDF from magic bytes regardless of extension', async () => {
    const source = fromText('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'invoice.txt');
    const result = await detectFormat(source);
    expect(result.kind).toBe('pdf');
    expect(result.method).toBe('magic');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('reports a mismatch when the extension disagrees with the bytes', async () => {
    const source = fromText('%PDF-1.4\n', 'report.docx');
    const result = await detectFormat(source);
    expect(result.kind).toBe('pdf');
    expect(result.mismatch).toEqual({ claimed: 'docx', actual: 'pdf' });
  });

  it('identifies PNG', async () => {
    const source = fromBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0], 'a.png');
    expect((await detectFormat(source)).kind).toBe('image');
  });

  it('identifies WebP through the wildcard size field', async () => {
    const bytes = [...'RIFF'].map((c) => c.charCodeAt(0));
    bytes.push(0x2a, 0x00, 0x00, 0x00);
    bytes.push(...[...'WEBP'].map((c) => c.charCodeAt(0)));
    expect((await detectFormat(fromBytes(bytes, 'x'))).kind).toBe('image');
  });

  it('distinguishes OOXML flavours inside a ZIP container', async () => {
    expect((await detectFormat(fromBytes(zipWithEntry('word/document.xml'), 'a.bin'))).kind).toBe('docx');
    expect((await detectFormat(fromBytes(zipWithEntry('xl/workbook.xml'), 'a.bin'))).kind).toBe('xlsx');
    expect((await detectFormat(fromBytes(zipWithEntry('ppt/presentation.xml'), 'a.bin'))).kind).toBe('pptx');
  });

  it('falls back to a plain ZIP when no OOXML part is present', async () => {
    const result = await detectFormat(fromBytes(zipWithEntry('images/cat.png'), 'archive.zip'));
    expect(result.kind).toBe('unknown');
    expect(result.mime).toBe('application/zip');
  });

  it('detects legacy CFB documents and uses the extension for the variant', async () => {
    const cfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0];
    expect((await detectFormat(fromBytes(cfb, 'old.xls'))).kind).toBe('xls');
    expect((await detectFormat(fromBytes(cfb, 'old.doc'))).kind).toBe('doc');
  });

  it('detects JSON and validates it when the whole file fits the sample', async () => {
    const result = await detectFormat(fromText('{"a": [1, 2, 3]}', 'data.json'));
    expect(result.kind).toBe('json');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('separates JSON Lines from JSON', async () => {
    const jsonl = '{"a":1}\n{"a":2}\n{"a":3}\n';
    expect((await detectFormat(fromText(jsonl, 'events.log'))).kind).toBe('jsonl');
  });

  it('separates SVG from other XML', async () => {
    expect((await detectFormat(fromText('<?xml version="1.0"?><svg xmlns="..."></svg>', 'a'))).kind).toBe('svg');
    expect((await detectFormat(fromText('<?xml version="1.0"?><root><a/></root>', 'a'))).kind).toBe('xml');
  });

  it('detects CSV by consistent field counts, not comma frequency', async () => {
    const csv = 'name,age,city\nada,36,london\ngrace,45,new york\n';
    expect((await detectFormat(fromText(csv, 'people.csv'))).kind).toBe('csv');

    // Prose with commas must not be mistaken for CSV.
    const prose = 'Hello, world. This is, in fact, prose.\nAnother line, with commas.\nAnd a third.\n';
    expect((await detectFormat(fromText(prose, 'note.txt'))).kind).toBe('text');
  });

  it('detects tab-separated data', async () => {
    const tsv = 'a\tb\tc\n1\t2\t3\n4\t5\t6\n';
    const result = await detectFormat(fromText(tsv, 'data.tsv'));
    expect(result.kind).toBe('csv');
    expect(result.mime).toBe('text/tab-separated-values');
  });

  it('detects markdown by structure when the extension is absent', async () => {
    const md = '# Title\n\nSome text with a [link](https://example.com).\n\n- one\n- two\n\n```js\ncode\n```\n';
    expect((await detectFormat(fromText(md, 'readme'))).kind).toBe('markdown');
  });

  it('treats binary content with NUL bytes as unknown rather than text', async () => {
    const result = await detectFormat(fromBytes([0x01, 0x00, 0x02, 0x00, 0x03], 'mystery'));
    expect(result.kind).toBe('unknown');
  });

  it('handles UTF-8 BOMs without misreading the file as binary', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"ok":true}')]);
    expect((await detectFormat(fromBytes(bytes, 'bom.json'))).kind).toBe('json');
  });

  it('returns a low-confidence guess for an empty file', async () => {
    const result = await detectFormat(memorySource(new Uint8Array(0), 'empty.txt'));
    expect(result.kind).toBe('text');
  });
});

describe('detectFormat for source code', () => {
  const fromCode = (text: string, name: string) =>
    blobSource(new Blob([new TextEncoder().encode(text)]), name);

  it('keeps a Python file with comment headings as text, not markdown', async () => {
    const python = '# Configuration\n# - loads settings\n# - [docs](http://x)\nimport os\n';
    expect((await detectFormat(fromCode(python, 'settings.py'))).kind).toBe('text');
  });

  it('keeps code with consistent commas as text, not CSV', async () => {
    const js = 'call(a, b, c);\ncall(d, e, f);\ncall(g, h, i);\n';
    expect((await detectFormat(fromCode(js, 'calls.js'))).kind).toBe('text');
  });

  it('still detects CSV when there is no code extension', async () => {
    expect((await detectFormat(fromCode('a,b,c\n1,2,3\n4,5,6\n', 'data'))).kind).toBe('csv');
  });
});

describe('detectFormat for spreadsheets', () => {
  const fromText = (text: string, name: string) => blobSource(new Blob([new TextEncoder().encode(text)]), name);

  it('identifies OpenDocument spreadsheets by their mimetype entry', async () => {
    const name = new TextEncoder().encode('mimetypeapplication/vnd.oasis.opendocument.spreadsheet');
    const header = new Uint8Array(30 + name.length);
    new DataView(header.buffer).setUint32(0, 0x04034b50, true);
    header.set(name, 30);
    expect((await detectFormat(blobSource(new Blob([header]), 'budget.bin'))).kind).toBe('ods');
  });

  it('sends an HTML table saved as .xls to the workbook viewer', async () => {
    const html = '<html><body><table><tr><td>1</td></tr></table></body></html>';
    expect((await detectFormat(fromText(html, 'export.xls'))).kind).toBe('xls');
  });

  it('sends Excel 2003 XML saved as .xls to the workbook viewer', async () => {
    const xml = '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"></Workbook>';
    expect((await detectFormat(fromText(xml, 'report.xls'))).kind).toBe('xls');
  });

  it('keeps ordinary XML as XML', async () => {
    expect((await detectFormat(fromText('<?xml version="1.0"?><root/>', 'data.xml'))).kind).toBe('xml');
  });
});
