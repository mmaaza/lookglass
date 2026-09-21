import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import * as XLSX from '../../../packages/lookglass/vendor/sheetjs/xlsx.mjs';

/**
 * Word fixtures.
 *
 *  - report.docx: saved "as if by Word", with `lastRenderedPageBreak`
 *    markers, so pages follow Word's pagination. Headings for the outline, a
 *    table of contents of internal links, a numbered list running across
 *    pages, an image, a table, headers, footers and a footnote. It also
 *    carries hostile content: a style whose font name injects CSS that tries
 *    to cover the host page and load a remote image, a `javascript:` link, a
 *    remote image reference and an HTML chunk with a script.
 *  - flow.docx: written "as if by a library", with no page-break markers at
 *    all — 20,000 paragraphs and a 4,000-row table in one run, which only
 *    stays usable if it is split into page-sized pieces.
 *  - locked.docx: a password-protected (encrypted) package.
 *  - memo.doc: a Word 97-2003 binary document.
 */

export const REPORT_CHAPTERS = 30;
export const REPORT_PAGES_PER_CHAPTER = 10;
export const LIST_ITEMS = 150;
export const FLOW_PARAGRAPHS = 20_000;
export const FLOW_TABLE_ROWS = 4_000;

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus posuere velit aliquet. ' +
  'Maecenas faucibus mollis interdum, nullam quis risus eget urna mollis ornare vel eu leo.';

const run = (text, props = '') =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (content, { style, numbering, pageBreakMarker } = {}) => {
  const pPr = [
    style ? `<w:pStyle w:val="${style}"/>` : '',
    numbering ? `<w:numPr><w:ilvl w:val="${numbering.level}"/><w:numId w:val="${numbering.id}"/></w:numPr>` : '',
  ].join('');
  // Word writes this marker at the point where it started a new page.
  const marker = pageBreakMarker ? '<w:r><w:lastRenderedPageBreak/></w:r>' : '';
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${marker}${content}</w:p>`;
};

const SECT_PR =
  '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/>' +
  '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';

function contentTypes({ image = false, header = false, altChunk = false, footnotes = false } = {}) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${image ? '<Default Extension="png" ContentType="image/png"/>' : ''}
  ${altChunk ? '<Default Extension="html" ContentType="text/html"/>' : ''}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  ${header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}
  ${header ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}
  ${footnotes ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : ''}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;
}

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const core = (title, creator) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${esc(title)}</dc:title>
  <dc:creator>${esc(creator)}</dc:creator>
</cp:coreProperties>`;

/**
 * The injected font name closes the generated rule, adds rules aimed at the
 * host (`:host`) and at a remote image, then reopens a rule so the rest of
 * the sheet still parses.
 */
const HOSTILE_FONT =
  'Evil;}:host{position:fixed!important;inset:0;z-index:99999;background:red}.x{background:url(http://127.0.0.1:9/pwned.png)} .y{font-family:Arial';

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="56"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Hostile"><w:name w:val="Hostile"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="${esc(HOSTILE_FONT)}" w:hAnsi="${esc(HOSTILE_FONT)}"/></w:rPr></w:style>
  <w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
    <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const header = (text) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}">${para(run(text))}</w:hdr>`;
const footer = (text) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="${W}">${para(run(text))}</w:ftr>`;

const FOOTNOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${W}">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p>${run('Footnote text for the executive summary.')}</w:p></w:footnote>
</w:footnotes>`;

/** A 16x16 PNG, solid blue, built by hand so it needs no image library. */
function bluePng() {
  const width = 16;
  const height = 16;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set([43, 108, 176], y * (width * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inlineImage(relId, name, emu) {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emu}" cy="${emu}"/><wp:docPr id="1" name="${name}"/>` +
    `<a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu}" cy="${emu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function documentXml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}"><w:body>${body}</w:body></w:document>`;
}

async function writeZip(path, files) {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

/* ------------------------------ report.docx ----------------------------- */

async function writeReport(root) {
  const body = [];
  const bookmark = (id, name) => `<w:bookmarkStart w:id="${id}" w:name="${name}"/><w:bookmarkEnd w:id="${id}"/>`;

  // Page 1: title, table of contents, links, image.
  body.push(para(run('Annual operations report'), { style: 'Title' }));
  body.push(para(run('Contents')));
  for (let chapter = 1; chapter <= REPORT_CHAPTERS; chapter++) {
    body.push(
      para(
        `<w:hyperlink w:anchor="_TocChapter${chapter}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>Chapter ${chapter} (toc)</w:t></w:r></w:hyperlink>`,
      ),
    );
  }
  body.push(
    para(
      `${run('Links: ')}<w:hyperlink r:id="rIdSafe"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>safe external link</w:t></w:r></w:hyperlink>` +
        `${run(' and ')}<w:hyperlink r:id="rIdScript"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>script link</w:t></w:r></w:hyperlink>`,
    ),
  );
  body.push(para(`${run('Logo: ')}${inlineImage('rIdImage', 'logo', 914400)}${run(' remote: ')}${inlineImage('rIdRemote', 'remote', 457200)}`));
  body.push(para(run('Styled by a hostile font declaration.'), { style: 'Hostile' }));
  body.push(`<w:altChunk r:id="rIdChunk"/>`);
  body.push(
    para(`${run('Executive summary with a footnote')}<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>`),
  );

  let page = 1;
  let listItem = 0;
  for (let chapter = 1; chapter <= REPORT_CHAPTERS; chapter++) {
    for (let local = 0; local < REPORT_PAGES_PER_CHAPTER; local++) {
      page++;
      if (local === 0) {
        body.push(para(`${bookmark(chapter, `_TocChapter${chapter}`)}${run(`Chapter ${chapter}`)}`, { style: 'Heading1', pageBreakMarker: true }));
      } else {
        body.push(para(run(`Section ${chapter}.${local}`), { style: 'Heading2', pageBreakMarker: true }));
      }
      // Chapter 2 carries the numbered list, 15 items per page across its pages.
      if (chapter === 2) {
        for (let i = 0; i < LIST_ITEMS / REPORT_PAGES_PER_CHAPTER; i++) {
          listItem++;
          body.push(para(run(`Requirement ${listItem}`), { style: 'ListParagraph', numbering: { id: 1, level: 0 } }));
        }
      }
      if (chapter === 3 && local === 1) {
        const rows = [['Region', 'Q1', 'Q2'], ['North', '120', '140'], ['South', '98', '101']];
        body.push(
          `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>` +
            `<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>` +
            rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${para(run(cell))}</w:tc>`).join('')}</w:tr>`).join('') +
            '</w:tbl>',
        );
      }
      const needle = chapter === REPORT_CHAPTERS && local === REPORT_PAGES_PER_CHAPTER - 2;
      for (let i = 0; i < 6; i++) {
        body.push(para(run(needle && i === 3 ? `The needle-marker sits on page ${page}.` : `${LOREM} (page ${page}, paragraph ${i + 1})`)));
      }
    }
  }
  body.push(SECT_PR);

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>
  <Relationship Id="rIdRemote" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://127.0.0.1:9/remote.png" TargetMode="External"/>
  <Relationship Id="rIdSafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>
  <Relationship Id="rIdScript" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(document.domain)" TargetMode="External"/>
  <Relationship Id="rIdChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/>
</Relationships>`;

  await writeZip(join(root, 'report.docx'), {
    '[Content_Types].xml': contentTypes({ image: true, header: true, altChunk: true, footnotes: true }),
    '_rels/.rels': PACKAGE_RELS,
    'docProps/core.xml': core('Annual operations report', 'lookglass fixtures'),
    'word/document.xml': documentXml(body.join('')),
    'word/_rels/document.xml.rels': rels,
    'word/styles.xml': STYLES,
    'word/numbering.xml': NUMBERING,
    'word/header1.xml': header('lookglass report header'),
    'word/footer1.xml': footer('Confidential footer'),
    'word/footnotes.xml': FOOTNOTES,
    'word/media/logo.png': bluePng(),
    'word/chunk.html': '<html><body><script>parent.postMessage("altchunk-ran","*")</script><p>alt chunk</p></body></html>',
  });
}

/* ------------------------------- flow.docx ------------------------------ */

async function writeFlow(root) {
  const body = [];
  body.push(para(run('Generated export'), { style: 'Title' }));
  for (let i = 1; i <= FLOW_PARAGRAPHS; i++) {
    if (i % 2000 === 1) body.push(para(run(`Part ${Math.ceil(i / 2000)}`), { style: 'Heading1' }));
    if (i > 5000 && i <= 5500) {
      body.push(para(run(`Step ${i - 5000}`), { numbering: { id: 1, level: 0 } }));
      continue;
    }
    body.push(para(run(i === FLOW_PARAGRAPHS - 100 ? `Row ${i}: the needle-marker is here.` : `Row ${i}: ${LOREM.slice(0, 90)}`)));
  }
  body.push(
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="6000"/></w:tblGrid>` +
      Array.from({ length: FLOW_TABLE_ROWS }, (_, r) => `<w:tr><w:tc>${para(run(`T${r + 1}`))}</w:tc><w:tc>${para(run(`table row ${r + 1}`))}</w:tc></w:tr>`).join('') +
      '</w:tbl>',
  );
  body.push(
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>',
  );
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;
  await writeZip(join(root, 'flow.docx'), {
    '[Content_Types].xml': contentTypes(),
    '_rels/.rels': PACKAGE_RELS,
    'docProps/core.xml': core('Generated export', 'a reporting library'),
    'word/document.xml': documentXml(body.join('')),
    'word/_rels/document.xml.rels': rels,
    'word/styles.xml': STYLES,
    'word/numbering.xml': NUMBERING,
  });
}

/* --------------------------- encrypted and legacy ----------------------- */

function compoundFile(streams) {
  const cfb = XLSX.CFB.utils.cfb_new();
  for (const [name, data] of Object.entries(streams)) XLSX.CFB.utils.cfb_add(cfb, `/${name}`, data);
  return XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'cfb' });
}

export async function writeDocxFixtures(root) {
  await writeReport(root);
  await writeFlow(root);
  // The real thing holds an AES-encrypted package; the viewer only needs to
  // recognise the container, so random bytes stand in for the ciphertext.
  await writeFile(
    join(root, 'locked.docx'),
    compoundFile({
      EncryptionInfo: Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]),
      EncryptedPackage: Buffer.alloc(8192, 0x5a),
    }),
  );
  await writeFile(join(root, 'memo.doc'), compoundFile({ WordDocument: Buffer.alloc(4096, 0), '1Table': Buffer.alloc(1024, 0) }));
}
