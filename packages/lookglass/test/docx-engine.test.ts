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

  it('widens an auto-fit column that is too narrow for its longest word', async () => {
    // Column 1 is stored at 40 px but holds an 88 px word; column 2 has room to spare.
    const table = (extra = '') =>
      `<w:tbl><w:tblPr>${extra}</w:tblPr><w:tblGrid><w:gridCol w:w="600"/><w:gridCol w:w="8400"/></w:tblGrid>` +
      `<w:tr><w:tc>${para('Performance')}</w:tc><w:tc>${para('Short')}</w:tc></w:tr></w:tbl>`;
    const cell = (layout: ReturnType<typeof layoutOf>) =>
      layout.display(0).items.filter((item) => item.t === 'text' && item.text === 'Performance');

    const auto = cell(layoutOf((await docx(table() + sectPr())).document));
    // One piece of text: the word was not broken across lines.
    expect(auto).toHaveLength(1);
    expect(auto[0]!.t === 'text' && auto[0]!.width).toBeCloseTo(88, 0);

    // A fixed-layout table keeps the stored widths, so the word does break.
    const fixed = cell(layoutOf((await docx(table('<w:tblLayout w:type="fixed"/>') + sectPr())).document));
    expect(fixed).toHaveLength(0);
  });

  it('takes auto-fit column widths from the cells when the stored grid is stale', async () => {
    const body =
      '<w:tbl><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>' +
      `<w:tr><w:tc><w:tcPr><w:tcW w:w="1500" w:type="dxa"/></w:tcPr>${para('A')}</w:tc>` +
      `<w:tc><w:tcPr><w:tcW w:w="7500" w:type="dxa"/></w:tcPr>${para('B')}</w:tc></w:tr></w:tbl>${sectPr()}`;
    const layout = layoutOf((await docx(body)).document);
    const [a, b] = layout.display(0).items.filter((item) => item.t === 'text');
    // Column 1 is 1500 twips (100 px) wide, not the 4500 the stale grid claims,
    // so the second cell's text starts 100 px in. Text sits after the 7.2 px cell margin.
    expect(a!.t === 'text' && a!.x).toBeCloseTo(103.2, 1);
    expect(b!.t === 'text' && b!.x).toBeCloseTo(203.2, 1);
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

describe('footnotes and endnotes', () => {
  const noteRef = (id: number, type: 'footnote' | 'endnote' = 'footnote') =>
    `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${type}Reference w:id="${id}"/></w:r>`;
  const notesPart = (type: 'footnote' | 'endnote', notes: Array<[number, string]>) =>
    `<w:${type}s ${W}><w:${type} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${type}>` +
    notes
      .map(([id, text]) => `<w:${type} w:id="${id}"><w:p><w:r><w:${type}Ref/></w:r><w:r><w:t xml:space="preserve"> ${text}</w:t></w:r></w:p></w:${type}>`)
      .join('') +
    `</w:${type}s>`;

  it('numbers footnotes in reference order and puts them at the bottom of the page', async () => {
    const body =
      `<w:p><w:r><w:t>First</w:t></w:r>${noteRef(7)}</w:p>` +
      `<w:p><w:r><w:t>Second</w:t></w:r>${noteRef(3)}</w:p>` +
      sectPr();
    // Stored out of order on purpose: numbering follows the references, not the ids.
    const parsed = await docx(body, { 'footnotes.xml': notesPart('footnote', [[3, 'note about second'], [7, 'note about first']]) });
    const layout = layoutOf(parsed.document);
    expect(layout.pages).toHaveLength(1);
    const items = layout.display(0).items.filter((item) => item.t === 'text');
    // Two reference marks in the text; each note starts with its own number.
    const marks = items.filter((item) => item.t === 'text' && (item.text === '1' || item.text === '2'));
    expect(marks).toHaveLength(2);
    const noteText = items.find((item) => item.t === 'text' && item.text.includes('note about first'))!;
    const bodyText = items.find((item) => item.t === 'text' && item.text === 'First')!;
    // The note is at the foot of the page, far below the paragraph it belongs to.
    expect(noteText.t === 'text' && noteText.y).toBeGreaterThan(bodyText.t === 'text' ? bodyText.y + 500 : 0);
    // Numbering follows reference order: id 7 is note 1.
    const firstNote = items.find((item) => item.t === 'text' && item.text.includes('note about first'))!;
    expect(firstNote.t === 'text' && firstNote.text.trim().startsWith('1')).toBe(true);
  });

  it('moves a line to the next page when its footnote no longer fits', async () => {
    const note = 'note '.repeat(200).trim();
    const body =
      Array.from({ length: 40 }, (_, i) => para(`Line ${i + 1}`)).join('') +
      `<w:p><w:r><w:t>Referring line</w:t></w:r>${noteRef(2)}</w:p>` +
      sectPr();
    const layout = layoutOf((await docx(body, { 'footnotes.xml': notesPart('footnote', [[2, note]]) })).document);
    // Without the note the line would fit on page 1; the note is ~8 lines tall.
    expect(layout.pages).toHaveLength(2);
    expect(layout.pageStarts[1]).toBe('Referring line1');
    expect(layout.text(1).text).toContain('note note');
  });

  it('collects endnotes at the end of the document', async () => {
    const body = `<w:p><w:r><w:t>Body</w:t></w:r>${noteRef(4, 'endnote')}</w:p>${sectPr()}`;
    const layout = layoutOf((await docx(body, { 'endnotes.xml': notesPart('endnote', [[4, 'the endnote']]) })).document);
    expect(layout.pages).toHaveLength(1);
    const items = layout.display(0).items.filter((item) => item.t === 'text');
    const endnote = items.find((item) => item.t === 'text' && item.text.includes('the endnote'))!;
    const bodyText = items.find((item) => item.t === 'text' && item.text === 'Body')!;
    // Endnotes follow the body text rather than sitting at the page foot.
    expect(endnote.t === 'text' && endnote.y).toBeGreaterThan(bodyText.t === 'text' ? bodyText.y : 0);
    expect(endnote.t === 'text' && endnote.y).toBeLessThan(200);
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
