/** @vitest-environment node */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { OoxmlPackage, resolvePartName, relsPartFor } from '../src/ooxml/opc.js';
import { child, children, decodeEntities, onOff, parseXml, textContent } from '../src/ooxml/xml.js';
import { ZipArchive } from '../src/ooxml/zip.js';
import { memorySource } from '../src/source/index.js';
import type { Source } from '../src/source/types.js';

async function zipOf(files: Record<string, string | Uint8Array>, compression: 'STORE' | 'DEFLATE' = 'DEFLATE') {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression }));
}

/** Wraps a source and records every range read. */
function counting(source: Source) {
  const reads: Array<[number, number]> = [];
  const wrapped: Source = Object.create(source);
  wrapped.slice = (start, end, signal) => {
    reads.push([start, end]);
    return source.slice(start, end, signal);
  };
  return { source: wrapped, reads };
}

describe('range ZIP reader', () => {
  it('lists entries from the directory and inflates one part without reading the rest', async () => {
    const big = new Uint8Array(2_000_000).map((_, i) => (i * 7919) % 251);
    const bytes = await zipOf({ 'a.xml': '<a>hello</a>', 'media/big.bin': big, 'z.txt': 'zed' });
    const { source, reads } = counting(memorySource(bytes, 'x.zip'));
    const zip = await ZipArchive.open(source);
    expect([...zip.entries.keys()].sort()).toEqual(['a.xml', 'media/big.bin', 'z.txt']);
    expect(new TextDecoder().decode(await zip.read('A.XML'))).toBe('<a>hello</a>');
    // Directory from the tail (at most 64 KB), then only the small part: the
    // 2 MB entry was not read.
    const readBytes = reads.reduce((sum, [start, end]) => sum + (end - start), 0);
    expect(readBytes).toBeLessThan(70_000 + 1000);
    expect(await zip.read('media/big.bin')).toEqual(big);
  });

  it('reads stored entries and refuses parts above the limit', async () => {
    const zip = await ZipArchive.open(memorySource(await zipOf({ 'a.txt': 'x'.repeat(5000) }, 'STORE'), 'x.zip'));
    expect((await zip.read('a.txt')).byteLength).toBe(5000);
    await expect(zip.read('a.txt', { maxBytes: 100 })).rejects.toMatchObject({ code: 'too-large' });
    await expect(zip.read('missing.xml')).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('stops an entry that inflates far past its declared size', async () => {
    const bytes = await zipOf({ 'bomb.xml': 'A'.repeat(1_000_000) });
    // Lie about the uncompressed size in the central directory.
    const view = new DataView(bytes.buffer);
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 10, true);
        break;
      }
    }
    const zip = await ZipArchive.open(memorySource(bytes, 'bomb.zip'));
    await expect(zip.read('bomb.xml')).rejects.toMatchObject({ code: 'too-large' });
  });

  it('rejects files that are not ZIPs', async () => {
    await expect(ZipArchive.open(memorySource(new Uint8Array(1000), 'x.zip'))).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('XML parser', () => {
  it('canonicalises prefixes by namespace, including Strict OOXML', () => {
    const transitional = parseXml(
      '<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body><x:p x:rsid="1"/></x:body></x:document>',
    );
    const strict = parseXml(
      '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body><w:p w:rsid="1"/></w:body></w:document>',
    );
    for (const root of [transitional, strict]) {
      expect(root.name).toBe('w:document');
      const p = child(child(root, 'w:body'), 'w:p');
      expect(p?.attrs['w:rsid']).toBe('1');
    }
  });

  it('keeps meaningful whitespace, decodes only predefined and numeric entities, never a DTD', () => {
    const root = parseXml(`<?xml version="1.0"?>
<!DOCTYPE r [<!ENTITY boom "BOOM"><!ENTITY x SYSTEM "file:///etc/passwd">]>
<r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:t xml:space="preserve">  two  spaces </w:t>
  <w:t>&lt;a&gt; &amp; &#233;&#x1F600; &boom; &x;</w:t>
  <!-- comment --><w:t><![CDATA[<raw>]]></w:t>
</r>`);
    const texts = children(root, 'w:t').map(textContent);
    expect(texts[0]).toBe('  two  spaces ');
    expect(texts[1]).toBe('<a> & é😀 &boom; &x;');
    expect(texts[2]).toBe('<raw>');
    expect(decodeEntities('&#0;')).toBe('�');
  });

  it('resolves markup compatibility to a branch we understand', () => {
    const root = parseXml(`<w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
      xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
      xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
      xmlns:x9="urn:future" mc:Ignorable="x9">
      <mc:AlternateContent>
        <mc:Choice Requires="x9"><w:t>future</w:t></mc:Choice>
        <mc:Choice Requires="wps"><w:t>shape</w:t></mc:Choice>
        <mc:Fallback><w:t>vml</w:t></mc:Fallback>
      </mc:AlternateContent>
      <x9:unknown><w:t>dropped</w:t></x9:unknown>
      <w:t>kept</w:t>
    </w:r>`);
    expect(children(root, 'w:t').map(textContent)).toEqual(['shape', 'kept']);
  });

  it('reads on/off properties the OOXML way', () => {
    const root = parseXml(
      '<w:rPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:b/><w:i w:val="0"/><w:caps w:val="true"/></w:rPr>',
    );
    expect(onOff(root, 'w:b')).toBe(true);
    expect(onOff(root, 'w:i')).toBe(false);
    expect(onOff(root, 'w:caps')).toBe(true);
    expect(onOff(root, 'w:strike')).toBeUndefined();
  });

  it('reports malformed XML', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(/mismatched/);
    expect(() => parseXml('<a x=1/>')).toThrow(/not quoted/);
  });
});

describe('packages', () => {
  it('resolves relationships relative to their part', async () => {
    const pkg = await OoxmlPackage.open(
      memorySource(
        await zipOf({
          '[Content_Types].xml':
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="doc/main"/></Types>',
          '_rels/.rels':
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
          'word/document.xml': '<doc/>',
          'word/_rels/document.xml.rels':
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://x/image" Target="media/a%20b.png"/><Relationship Id="rId6" Type="http://x/header" Target="../word/./header1.xml"/><Relationship Id="rId7" Type="http://x/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>',
        }),
        'x.docx',
      ),
    );
    expect(await pkg.relatedPart('/', 'officeDocument')).toBe('/word/document.xml');
    const rels = await pkg.rels('/word/document.xml');
    expect(rels.get('rId5')).toMatchObject({ type: 'image', target: '/word/media/a b.png', external: false });
    expect(rels.get('rId6')?.target).toBe('/word/header1.xml');
    expect(rels.get('rId7')).toMatchObject({ external: true, target: 'https://example.com/' });
    expect(await pkg.contentType('/word/document.xml')).toBe('doc/main');
    expect(await pkg.contentType('/word/media/x.PNG')).toBe('image/png');
  });

  it('names relationship parts and normalises targets', () => {
    expect(relsPartFor('/word/document.xml')).toBe('/word/_rels/document.xml.rels');
    expect(relsPartFor('/')).toBe('/_rels/.rels');
    expect(resolvePartName('/ppt/slides/', '../media/image1.png')).toBe('/ppt/media/image1.png');
    expect(resolvePartName('/word/', '/customXml/item1.xml')).toBe('/customXml/item1.xml');
  });
});
