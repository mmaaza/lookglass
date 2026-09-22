/** @vitest-environment node */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { FontResolver } from '../src/ooxml/fonts.js';
import { OoxmlPackage } from '../src/ooxml/opc.js';
import { TextMeasurer } from '../src/ooxml/text.js';
import { DocxFontService, DocxLayout } from '../src/formats/docx/layout/engine.js';
import { formatNumber } from '../src/formats/docx/numbering.js';
import { parseWordDocument } from '../src/formats/docx/parse.js';
import { memorySource } from '../src/source/index.js';

/**
 * Engine tests with a deterministic stand-in for canvas text measurement:
 * every character is half the font size wide, and Word's own metrics for
 * Times New Roman set line heights (13.8 pt for 12 pt text).
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

async function docx(body: string, extra: Record<string, string> = {}, styles = '') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document ${W}><w:body>${body}</w:body></w:document>`);
  const rels = ['<Relationship Id="rs" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'];
  zip.file('word/styles.xml', `<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${styles}</w:styles>`);
  for (const [name, xml] of Object.entries(extra)) {
    zip.file(`word/${name}`, xml);
    rels.push(`<Relationship Id="${name}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${name.startsWith('header') ? 'header' : name.startsWith('footer') ? 'footer' : name.replace('.xml', '')}" Target="${name}"/>`);
  }
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  const pkg = await OoxmlPackage.open(memorySource(await zip.generateAsync({ type: 'uint8array' }), 'test.docx'));
  return parseWordDocument(pkg);
}

function layoutOf(doc: Awaited<ReturnType<typeof docx>>['document']) {
  const context = {
    font: '',
    measureText(text: string) {
      const size = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 16);
      return { width: text.length * size * 0.5, fontBoundingBoxAscent: size * 0.9, fontBoundingBoxDescent: size * 0.25 };
    },
  };
  const layout = new DocxLayout(doc, new DocxFontService(new FontResolver({ isInstalled: () => true }), new TextMeasurer(context)));
  for (const _ of layout.run()) void _;
  return layout;
}

const para = (text: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const sectPr = (type = 'nextPage') => `<w:sectPr><w:type w:val="${type}"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr>`;

describe('Word layout engine', () => {
  it('fills a page at Word line heights and breaks to the next', async () => {
    // 9 in of text area / 13.8 pt lines = 46.9, so 46 lines fit on a page.
    const { document } = await docx(Array.from({ length: 50 }, (_, i) => para(`Line ${i + 1}`)).join('') + sectPr());
    const layout = layoutOf(document);
    expect(layout.pages).toHaveLength(2);
    expect(layout.pageStarts[1]).toBe('Line 47');
  });

  it('uses the larger of two neighbouring spacings, not their sum', async () => {
    const spaced = '<w:spacing w:before="240" w:after="240"/>';
    const { document } = await docx(Array.from({ length: 40 }, (_, i) => para(`P${i + 1}`, spaced)).join('') + sectPr());
    const layout = layoutOf(document);
    // 12 pt before the first, then 13.8 + 12 pt each (shared, not doubled):
    // 25 fit in 648 pt, so P26 opens page 2. Adding the spacings would fit 17.
    expect(layout.pages).toHaveLength(2);
    expect(layout.pageStarts[1]).toBe('P26');
  });

  it('does not leave a blank page where a page break meets a section break', async () => {
    const body =
      para('Front') +
      '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' +
      `<w:p><w:pPr>${sectPr()}</w:pPr></w:p>` +
      para('Chapter one') +
      sectPr();
    const layout = layoutOf((await docx(body)).document);
    expect(layout.pages).toHaveLength(2);
    expect(layout.pageStarts[1]).toBe('Chapter one');
  });

  it('keeps widow and orphan lines off page edges', async () => {
    // 45 single lines, then a 3-line paragraph: only 1 of its lines would fit on page 1.
    const long = 'word '.repeat(60).trim();
    const body = Array.from({ length: 45 }, (_, i) => para(`Line ${i + 1}`)).join('') + para(long) + sectPr();
    const layout = layoutOf((await docx(body)).document);
    expect(layout.pages).toHaveLength(2);
    // The whole paragraph moves rather than leaving its first line alone at the bottom.
    expect(layout.pageStarts[1]!.startsWith('word word')).toBe(true);
  });

  it('numbers pages per section and fills PAGE and NUMPAGES fields in footers', async () => {
    const footer = `<w:ftr ${W}><w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>9</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> of </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>9</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
    const section = (fmt: string, start?: number) =>
      `<w:sectPr><w:footerReference w:type="default" r:id="footer1.xml"/><w:pgNumType w:fmt="${fmt}"${start ? ` w:start="${start}"` : ''}/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr>`;
    const body = `${para('Preface')}<w:p><w:pPr>${section('lowerRoman')}</w:pPr><w:r><w:t>end</w:t></w:r></w:p>${para('Body')}${section('decimal', 1)}`;
    const layout = layoutOf((await docx(body, { 'footer1.xml': footer })).document);
    const footerText = (page: number) =>
      layout
        .display(page)
        .items.filter((item) => item.t === 'text')
        .map((item) => (item.t === 'text' ? item.text : ''))
        .join('');
    expect(footerText(0)).toContain('Page i of 2');
    expect(footerText(1)).toContain('Page 1 of 2');
  });

  it('splits a tall table row across pages', async () => {
    const cellText = Array.from({ length: 80 }, (_, i) => para(`cell line ${i + 1}`)).join('');
    const body = `${para('Intro')}<w:tbl><w:tblGrid><w:gridCol w:w="9000"/></w:tblGrid><w:tr><w:tc>${cellText}</w:tc></w:tr></w:tbl>${sectPr()}`;
    const layout = layoutOf((await docx(body)).document);
    expect(layout.pages).toHaveLength(2);
    // The row starts on page 1 right after the intro instead of jumping to page 2 whole.
    const firstPageText = layout.text(0).text;
    expect(firstPageText).toContain('cell line 1 ');
    expect(layout.text(1).text).toContain('cell line 80');
  });
});

describe('number formats', () => {
  it('formats list and page numbers as Word does', () => {
    expect(formatNumber(4, 'upperRoman')).toBe('IV');
    expect(formatNumber(28, 'lowerLetter')).toBe('bb');
    expect(formatNumber(3, 'ordinal')).toBe('3rd');
    expect(formatNumber(12, 'ordinal')).toBe('12th');
    expect(formatNumber(21, 'cardinalText')).toBe('Twenty-one');
    expect(formatNumber(2, 'ordinalText')).toBe('Second');
    expect(formatNumber(7, 'decimalZero')).toBe('07');
  });
});

describe('style inheritance', () => {
  it('flips toggle properties across style levels and lets direct formatting win', async () => {
    const styles =
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>';
    const body =
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>bold</w:t></w:r><w:r><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:t>flipped</w:t></w:r><w:r><w:rPr><w:rStyle w:val="Strong"/><w:b/></w:rPr><w:t>direct</w:t></w:r></w:p>' +
      sectPr();
    const { document } = await docx(body, {}, styles);
    const runs = document.body[0]!.kind === 'p' ? document.body[0]!.inlines : [];
    const bold = runs.map((inline) => (inline.kind === 'text' ? inline.props.bold : undefined));
    expect(bold).toEqual([true, false, true]);
    expect(document.headings).toEqual([{ level: 0, text: 'boldflippeddirect', block: 0 }]);
  });
});
