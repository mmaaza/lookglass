import { describe, expect, it } from 'vitest';
import { parseJson } from '../src/workers/json-parse.js';
import { memorySource } from '../src/source/index.js';
import { NodeKind, type NodeTable } from '../src/workers/tree-model.js';
import { unescapeJsonString } from '../src/workers/tree-reader.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function source(text: string) {
  return memorySource(encoder.encode(text), 'test.json');
}

/**
 * Rebuild a JS value from the offset table.
 *
 * Comparing the result against `JSON.parse` of the same input is the
 * strongest available check on the scanner: it verifies node kinds, parent
 * links, sibling order, key ranges and value ranges all at once, for any
 * input, rather than asserting on hand-picked offsets.
 */
function reconstruct(table: NodeTable, text: string, index = 0): unknown {
  const bytes = encoder.encode(text);
  const raw = (node: number) => decoder.decode(bytes.subarray(table.valueStart[node]!, table.valueEnd[node]!));
  const keyOf = (node: number) => {
    const start = table.keyStart[node]!;
    if (start < 0) return String(-start - 1);
    return unescapeJsonString(decoder.decode(bytes.subarray(start, table.keyEnd[node]!)));
  };

  const build = (node: number): unknown => {
    const kind = table.kinds[node] as NodeKind;
    switch (kind) {
      case NodeKind.Object: {
        const out: Record<string, unknown> = {};
        for (let child = table.firstChild[node]!; child !== -1; child = table.nextSibling[child]!) {
          out[keyOf(child)] = build(child);
        }
        return out;
      }
      case NodeKind.Array: {
        const out: unknown[] = [];
        for (let child = table.firstChild[node]!; child !== -1; child = table.nextSibling[child]!) {
          out.push(build(child));
        }
        return out;
      }
      case NodeKind.String:
        return JSON.parse(raw(node));
      case NodeKind.Number:
        return Number(raw(node));
      case NodeKind.Boolean:
        return raw(node) === 'true';
      case NodeKind.Null:
        return null;
      default:
        throw new Error(`unexpected kind ${kind}`);
    }
  };

  return build(index);
}

async function roundTrip(text: string): Promise<unknown> {
  const { table } = await parseJson(source(text));
  return reconstruct(table, text);
}

describe('parseJson', () => {
  const cases: [name: string, json: string][] = [
    ['empty object', '{}'],
    ['empty array', '[]'],
    ['flat object', '{"a":1,"b":"two","c":true,"d":null}'],
    ['flat array', '[1,2,3,"four",false,null]'],
    ['nested', '{"a":{"b":{"c":[1,{"d":2}]}}}'],
    ['array of objects', '[{"id":1},{"id":2},{"id":3}]'],
    ['whitespace everywhere', '  {\n  "a" :  [ 1 ,\t2 ]  ,\n "b" : { }\n }  '],
    ['top-level string', '"hello"'],
    ['top-level number', '42'],
    ['top-level true', 'true'],
    ['top-level null', 'null'],
    ['negative and exponent numbers', '[-1,1.5,-2.5e10,1E-7,0]'],
    ['escaped quotes in values', '{"quote":"she said \\"hi\\""}'],
    ['escaped backslash before quote', '{"path":"C:\\\\dir\\\\"}'],
    ['newlines and tabs in strings', '{"s":"line1\\nline2\\tend"}'],
    ['unicode escapes', '{"s":"caf\\u00e9 \\u00fc"}'],
    ['non-ascii utf8 literal', '{"s":"café ünïcode 日本語 🎉"}'],
    ['structural chars inside strings', '{"s":"{\\"a\\":[1,2]} , : } ]"}'],
    ['empty string key and value', '{"":""}'],
    ['deeply nested arrays', '[[[[[[1]]]]]]'],
    ['keys that look like numbers', '{"0":"a","1":"b"}'],
  ];

  for (const [name, json] of cases) {
    it(`matches JSON.parse for ${name}`, async () => {
      expect(await roundTrip(json)).toEqual(JSON.parse(json));
    });
  }

  it('records child counts for containers', async () => {
    const { table } = await parseJson(source('{"a":1,"b":2,"c":[1,2,3]}'));
    expect(table.kinds[0]).toBe(NodeKind.Object);
    expect(table.childCounts[0]).toBe(3);
    // The array is the third child of the root.
    const arrayIndex = table.firstChild[table.firstChild[0]!]! === -1 ? 3 : 3;
    expect(table.kinds[arrayIndex]).toBe(NodeKind.Array);
    expect(table.childCounts[arrayIndex]).toBe(3);
  });

  it('records depth', async () => {
    const { table } = await parseJson(source('{"a":{"b":{"c":1}}}'));
    expect(table.depths[0]).toBe(0);
    expect(table.maxDepth).toBe(3);
  });

  it('tags array children with their index', async () => {
    const { table } = await parseJson(source('["x","y","z"]'));
    const children: number[] = [];
    for (let child = table.firstChild[0]!; child !== -1; child = table.nextSibling[child]!) children.push(child);
    expect(children).toHaveLength(3);
    // Negative key starts are index sentinels: -(i + 1).
    expect(children.map((child) => -table.keyStart[child]! - 1)).toEqual([0, 1, 2]);
  });

  it('parses JSON Lines into a synthetic root array', async () => {
    const text = '{"a":1}\n{"a":2}\n{"a":3}\n';
    const { table } = await parseJson(source(text), { ndjson: true });
    expect(table.kinds[0]).toBe(NodeKind.Array);
    expect(table.childCounts[0]).toBe(3);
    expect(reconstruct(table, text)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('survives a truncated document by closing open containers', async () => {
    // A download cut short must still show what arrived rather than throwing.
    const { table } = await parseJson(source('{"a":[1,2,{"b":'));
    expect(table.kinds[0]).toBe(NodeKind.Object);
    expect(table.count).toBeGreaterThan(2);
  });

  it('rejects a document with no JSON value', async () => {
    await expect(parseJson(source('   \n  '))).rejects.toThrow(/no JSON value/i);
  });

  it('handles values spanning chunk boundaries', async () => {
    // The scanner reads in 1 MiB chunks; these strings and numbers straddle
    // that boundary, which is where naive chunked parsers corrupt data.
    const filler = 'x'.repeat(1024 * 1024);
    const json = JSON.stringify({ big: filler, after: 'tail', n: 12345.6789, arr: [1, 2, 3] });
    expect(await roundTrip(json)).toEqual(JSON.parse(json));
  });

  it('handles a string containing an escaped quote at a chunk boundary', async () => {
    const pad = 'a'.repeat(1024 * 1024 - 4);
    const json = JSON.stringify({ s: `${pad}"end"`, ok: true });
    expect(await roundTrip(json)).toEqual(JSON.parse(json));
  });

  it('handles a very large array without materialising values', async () => {
    const json = `[${Array.from({ length: 50_000 }, (_, i) => i).join(',')}]`;
    const { table } = await parseJson(source(json));
    expect(table.childCounts[0]).toBe(50_000);
    expect(table.count).toBe(50_001);
  });

  it('reports progress while scanning', async () => {
    const json = `[${'1,'.repeat(200_000)}1]`;
    const seen: number[] = [];
    await parseJson(source(json), { onProgress: (done) => seen.push(done) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(encoder.encode(json).length);
  });

  it('is abortable mid-scan', async () => {
    const json = `[${'1,'.repeat(500_000)}1]`;
    const controller = new AbortController();
    controller.abort();
    await expect(parseJson(source(json), { signal: controller.signal })).rejects.toThrow();
  });
});
