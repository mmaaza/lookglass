import { describe, expect, it } from 'vitest';
import { memorySource } from '../src/source/index.js';
import { cellType, indexRows, parseRows, sniffDialect, type CsvDialect } from '../src/workers/csv-scan.js';

const utf8 = (text: string) => new TextEncoder().encode(text);

function utf16le(text: string, bom = true): Uint8Array {
  const body = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    body[i * 2] = code & 0xff;
    body[i * 2 + 1] = code >> 8;
  }
  return bom ? new Uint8Array([0xff, 0xfe, ...body]) : body;
}

/**
 * Read every row back through the index, one row at a time, exactly as the
 * worker serves windows. Comparing against a whole-text parse checks every
 * offset the indexer produced, for any input.
 */
async function rowsViaIndex(bytes: Uint8Array, dialect?: CsvDialect): Promise<string[][]> {
  const source = memorySource(bytes, 'x.csv');
  const d = dialect ?? sniffDialect(bytes.subarray(0, 64 * 1024));
  const index = await indexRows(source, d);
  const decoder = new TextDecoder(d.encoding);
  const out: string[][] = [];
  for (let r = 0; r < index.rowCount; r++) {
    const start = index.offsets[r]!;
    const end = r + 1 < index.rowCount ? index.offsets[r + 1]! : index.indexedBytes;
    const text = decoder.decode(bytes.subarray(start, end));
    out.push(parseRows(text, d.delimiter, 1)[0] ?? ['']);
  }
  return out;
}

describe('parseRows', () => {
  it('parses quoted fields, escaped quotes and embedded delimiters', () => {
    expect(parseRows('a,"b,c","say ""hi"""\n', ',')).toEqual([['a', 'b,c', 'say "hi"']]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseRows('id,note\n1,"line one\nline two"\n2,x\n', ',')).toEqual([
      ['id', 'note'],
      ['1', 'line one\nline two'],
      ['2', 'x'],
    ]);
  });

  it('handles CRLF, lone CR, and a missing final newline', () => {
    expect(parseRows('a,b\r\nc,d\re,f', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('keeps empty fields', () => {
    expect(parseRows(',,\n', ',')).toEqual([['', '', '']]);
  });

  it('treats a quote inside an unquoted field as a literal', () => {
    expect(parseRows('5" floppy,ok\n', ',')).toEqual([['5" floppy', 'ok']]);
  });
});

describe('indexRows', () => {
  const cases: [string, string][] = [
    ['simple', 'a,b,c\n1,2,3\n4,5,6\n'],
    ['no trailing newline', 'a,b\n1,2'],
    ['CRLF', 'a,b\r\n1,2\r\n3,4\r\n'],
    ['lone CR (classic Mac)', 'a,b\r1,2\r3,4\r'],
    ['quoted newlines', 'id,note\n1,"multi\nline\nfield"\n2,"x"\n'],
    ['quoted CRLF', 'id,note\r\n1,"a\r\nb"\r\n2,c\r\n'],
    ['escaped quotes', 'q\n"he said ""no"""\n"x"""\n'],
    ['blank lines', 'a\n\nb\n'],
    ['unquoted stray quote', 'size,label\n5" floppy,disk\n3,x\n'],
    ['unicode', 'name,city\nZoë,Kraków\n李,東京\n'],
  ];

  for (const [name, csv] of cases) {
    it(`matches a whole-file parse: ${name}`, async () => {
      expect(await rowsViaIndex(utf8(csv))).toEqual(parseRows(csv, ','));
    });
  }

  it('reports the widest row', async () => {
    const index = await indexRows(memorySource(utf8('a,b\n1,2,3,4\n5\n'), 'x.csv'), sniffDialect(utf8('a,b')));
    expect(index.maxColumns).toBe(4);
  });

  it('handles rows and quoted fields spanning the 1 MiB chunk boundary', async () => {
    // A quoted field with an embedded newline that straddles the chunk edge
    // is where a chunked scanner loses its quote state.
    const filler = 'x'.repeat(1024 * 1024 - 20);
    const csv = `a,b\n1,"${filler}\nstill quoted"\n2,after\n`;
    const rows = await rowsViaIndex(utf8(csv));
    expect(rows).toHaveLength(3);
    expect(rows[1]![1]).toBe(`${filler}\nstill quoted`);
    expect(rows[2]).toEqual(['2', 'after']);
  });

  it('handles CRLF split across the chunk boundary', async () => {
    const filler = 'y'.repeat(1024 * 1024 - 1);
    const csv = `${filler}\r\nnext,row\r\n`;
    const rows = await rowsViaIndex(utf8(csv));
    expect(rows).toEqual([[filler], ['next', 'row']]);
  });

  it('indexes UTF-16LE (Excel "Unicode text") in two-byte units', async () => {
    // U+0A0A has 0x0A in both bytes: a byte-wise scan would split rows there.
    const tsv = 'name\tvalue\nਊfirst\t1\nsecond\t2\n';
    const bytes = utf16le(tsv);
    const dialect = sniffDialect(bytes);
    expect(dialect).toMatchObject({ encoding: 'utf-16le', bomBytes: 2, delimiter: '\t' });
    expect(await rowsViaIndex(bytes, dialect)).toEqual([
      ['name', 'value'],
      ['ਊfirst', '1'],
      ['second', '2'],
    ]);
  });

  it('skips a UTF-8 byte-order mark', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('a,b\n1,2\n')]);
    expect(await rowsViaIndex(bytes)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('stops at the row cap and says so', async () => {
    const csv = Array.from({ length: 100 }, (_, i) => `${i}`).join('\n');
    const index = await indexRows(memorySource(utf8(csv), 'x.csv'), sniffDialect(utf8(csv)), { maxRows: 10 });
    expect(index.truncated).toBe(true);
    expect(index.rowCount).toBe(10);
  });
});

describe('sniffDialect', () => {
  it('prefers semicolons for European CSV with decimal commas', () => {
    const csv = 'name;price;qty\nwidget;1,50;3\ngadget;12,75;1\nthing;0,99;12\n';
    expect(sniffDialect(utf8(csv)).delimiter).toBe(';');
  });

  it('detects tabs and pipes', () => {
    expect(sniffDialect(utf8('a\tb\tc\n1\t2\t3\n')).delimiter).toBe('\t');
    expect(sniffDialect(utf8('a|b|c\n1|2|3\n')).delimiter).toBe('|');
  });

  it('falls back to Windows-1252 for invalid UTF-8', () => {
    const bytes = new Uint8Array([...utf8('name,city\n'), 0x5a, 0x6f, 0xeb, 0x2c, 0x78, 0x0a]);
    expect(sniffDialect(bytes).encoding).toBe('windows-1252');
  });
});

describe('cellType', () => {
  it.each(['42', '-3.5', '1,234,567', '1e10', '12%', '+7'])('treats %s as a number', (value) => {
    expect(cellType(value)).toBe('n');
  });
  it.each(['abc', '12 apples', '', '-', '1.2.3', 'ZIP 90210'])('treats %s as text', (value) => {
    expect(cellType(value)).toBe('s');
  });
});
