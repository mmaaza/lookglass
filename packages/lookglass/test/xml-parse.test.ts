import { describe, expect, it } from 'vitest';
import { memorySource } from '../src/source/index.js';
import { ExpansionState, NodeKind, type NodeTable } from '../src/workers/tree-model.js';
import { decodeXmlText, parseAttributes } from '../src/workers/tree-reader.js';
import { parseXml } from '../src/workers/xml-parse.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function source(text: string) {
  return memorySource(encoder.encode(text), 'test.xml');
}

/** Render the parsed tree as an indented outline for readable assertions. */
function outline(table: NodeTable, text: string): string[] {
  const bytes = encoder.encode(text);
  const span = (start: number, end: number) => decoder.decode(bytes.subarray(start, end));
  const lines: string[] = [];

  const walk = (node: number) => {
    const kind = table.kinds[node] as NodeKind;
    const indent = '  '.repeat(table.depths[node]!);
    const label =
      kind === NodeKind.Element
        ? span(table.keyStart[node]!, table.keyEnd[node]!)
        : `#${NodeKind[kind].toLowerCase()}:${span(table.valueStart[node]!, table.valueEnd[node]!).trim()}`;
    lines.push(indent + label);
    for (let child = table.firstChild[node]!; child !== -1; child = table.nextSibling[child]!) walk(child);
  };

  // Node 0 is the synthetic document root; its children are the real top level.
  for (let top = table.firstChild[0]!; top !== -1; top = table.nextSibling[top]!) walk(top);
  return lines;
}

async function parse(text: string) {
  const result = await parseXml(source(text));
  return { ...result, outline: outline(result.table, text) };
}

describe('parseXml', () => {
  it('parses nested elements', async () => {
    const xml = '<root><a><b>text</b></a><c/></root>';
    const { outline: lines } = await parse(xml);
    expect(lines).toEqual(['root', '  a', '    b', '      #text:text', '  c']);
  });

  it('handles self-closing elements', async () => {
    const { table } = await parse('<root><br/><img src="x"/></root>');
    expect(table.childCounts[1]).toBe(2);
    // Self-closing elements are complete: they must not swallow siblings.
    expect(table.childCounts[2]).toBe(0);
    expect(table.childCounts[3]).toBe(0);
  });

  it('skips whitespace-only text between elements', async () => {
    const xml = '<root>\n  <a>x</a>\n  <b>y</b>\n</root>';
    const { table } = await parse(xml);
    // Two elements, not two elements plus three whitespace text nodes.
    expect(table.childCounts[1]).toBe(2);
  });

  it('keeps an attribute value containing a greater-than sign intact', async () => {
    // Scanning for the next '>' without tracking quotes truncates this tag.
    const xml = '<root><item expr="a > b" other="1">v</item></root>';
    const { table } = await parse(xml);
    const attrs = parseAttributes(
      decoder.decode(encoder.encode(xml).subarray(table.auxStart[2]!, table.auxEnd[2]!)),
    );
    expect(attrs).toEqual([
      ['expr', 'a > b'],
      ['other', '1'],
    ]);
    expect(table.childCounts[1]).toBe(1);
  });

  it('parses single-quoted attributes', async () => {
    const xml = "<root><a href='/x?a=1&amp;b=2'/></root>";
    const { table } = await parse(xml);
    const attrs = parseAttributes(
      decoder.decode(encoder.encode(xml).subarray(table.auxStart[2]!, table.auxEnd[2]!)),
    );
    expect(attrs).toEqual([['href', '/x?a=1&b=2']]);
  });

  it('captures comments and CDATA as their own nodes', async () => {
    const xml = '<root><!-- note --><![CDATA[ raw <not> markup ]]></root>';
    const { table } = await parse(xml);
    expect(table.kinds[2]).toBe(NodeKind.Comment);
    expect(table.kinds[3]).toBe(NodeKind.CData);
    const bytes = encoder.encode(xml);
    expect(decoder.decode(bytes.subarray(table.valueStart[3]!, table.valueEnd[3]!))).toBe(' raw <not> markup ');
  });

  it('does not treat markup inside CDATA as structure', async () => {
    const xml = '<root><![CDATA[<a><b></b></a>]]><real/></root>';
    const { table } = await parse(xml);
    // CDATA plus one real element — the markup inside CDATA is inert.
    expect(table.childCounts[1]).toBe(2);
  });

  it('reads the declared encoding from the XML declaration', async () => {
    const { encoding } = await parse('<?xml version="1.0" encoding="ISO-8859-1"?><root/>');
    expect(encoding).toBe('ISO-8859-1');
  });

  it('keeps processing instructions but not the XML declaration', async () => {
    const { table } = await parse('<?xml version="1.0"?><?php echo 1; ?><root/>');
    // The PI and the root element are siblings under the document root.
    expect(table.kinds[1]).toBe(NodeKind.Instruction);
    expect(table.kinds[2]).toBe(NodeKind.Element);
    expect(table.childCounts[0]).toBe(2);
  });

  it('skips a DOCTYPE with an internal subset', async () => {
    const xml = '<!DOCTYPE note [ <!ELEMENT note (#PCDATA)> ]><note>hi</note>';
    const { table } = await parse(xml);
    expect(table.kinds[1]).toBe(NodeKind.Doctype);
    // The subset must not be mistaken for elements.
    expect(table.kinds[2]).toBe(NodeKind.Element);
  });

  it('flags declared entities instead of expanding them', async () => {
    // The billion-laughs shape. Detecting and refusing is the whole defence.
    const xml =
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';
    const { entitiesDeclared, table } = await parse(xml);
    expect(entitiesDeclared).toBe(true);
    // Parsing completed in bounded time and the reference stayed literal.
    const bytes = encoder.encode(xml);
    const text = decoder.decode(bytes.subarray(table.valueStart[3]!, table.valueEnd[3]!));
    expect(text).toBe('&lol2;');
  });

  it('never resolves an external entity reference', async () => {
    const xml = '<!DOCTYPE d [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><d>&xxe;</d>';
    const { entitiesDeclared } = await parse(xml);
    expect(entitiesDeclared).toBe(true);
    // Nothing in the parser can fetch: there is no entity resolution at all.
  });

  it('counts mismatched closing tags without failing', async () => {
    const { mismatched, table } = await parse('<root><a>x</b></root>');
    expect(mismatched).toBe(1);
    expect(table.kinds[1]).toBe(NodeKind.Element);
  });

  it('clamps unclosed elements at end of file', async () => {
    const { table } = await parse('<root><a><b>text');
    expect(table.count).toBeGreaterThanOrEqual(4);
    expect(table.valueEnd[1]).toBe(encoder.encode('<root><a><b>text').length);
  });

  it('rejects a document with no elements', async () => {
    await expect(parseXml(source('just text, no markup'))).rejects.toThrow(/no XML elements/i);
  });

  it('handles namespaced element and attribute names', async () => {
    const xml = '<soap:Envelope xmlns:soap="http://x"><soap:Body/></soap:Envelope>';
    const { outline: lines } = await parse(xml);
    expect(lines).toEqual(['soap:Envelope', '  soap:Body']);
  });

  it('handles constructs spanning chunk boundaries', async () => {
    // The reader window is 1 MiB; this text node and the tag after it cross it.
    const filler = 'x'.repeat(1024 * 1024 + 17);
    const xml = `<root><big>${filler}</big><after attr="1">tail</after></root>`;
    const { table } = await parse(xml);
    expect(table.childCounts[1]).toBe(2);
    const bytes = encoder.encode(xml);
    const afterName = decoder.decode(bytes.subarray(table.keyStart[4]!, table.keyEnd[4]!));
    expect(afterName).toBe('after');
  });

  it('finds a comment terminator that straddles the window edge', async () => {
    const filler = 'c'.repeat(1024 * 1024 - 2);
    const xml = `<root><!--${filler}--><tail/></root>`;
    const { table } = await parse(xml);
    expect(table.kinds[2]).toBe(NodeKind.Comment);
    expect(table.childCounts[1]).toBe(2);
  });

  it('shows a root element that follows a top-level comment', async () => {
    // Regression: with node 0 treated as the only root, everything after a
    // leading comment was invisible and the document rendered as one row.
    const xml = '<?xml version="1.0"?>\n<!-- generated -->\n<catalog><item/><item/></catalog>';
    const { table, outline: lines } = await parse(xml);
    expect(lines).toEqual(['#comment:generated', 'catalog', '  item', '  item']);

    const expansion = new ExpansionState(table, true);
    expansion.expandToDepth(3);
    // Comment, catalog and its two items; the synthetic root is never a row.
    expect(expansion.visibleCount()).toBe(4);
    expect(expansion.slice(0, 4).map((index) => table.kinds[index])).toEqual([
      NodeKind.Comment,
      NodeKind.Element,
      NodeKind.Element,
      NodeKind.Element,
    ]);
    // The hidden root cannot be collapsed away.
    expansion.collapseAll();
    expect(expansion.visibleCount()).toBe(2);
  });
});

describe('decodeXmlText', () => {
  it('decodes the five predefined entities', () => {
    expect(decodeXmlText('&lt;a&gt; &amp; &quot;q&quot; &apos;s&apos;')).toBe(`<a> & "q" 's'`);
  });

  it('decodes numeric character references', () => {
    expect(decodeXmlText('&#65;&#x42;&#x1F600;')).toBe('AB\u{1F600}');
  });

  it('leaves unknown entities literal', () => {
    // Refusing to expand is what makes entity-expansion attacks impossible.
    expect(decodeXmlText('&lol2; &custom;')).toBe('&lol2; &custom;');
  });

  it('rejects surrogate and out-of-range code points', () => {
    expect(decodeXmlText('&#xD800;')).toBe('&#xD800;');
    expect(decodeXmlText('&#x110000;')).toBe('&#x110000;');
  });
});
