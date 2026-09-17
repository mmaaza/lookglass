import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PdfBuilder, literal } from './pdf-writer.mjs';

export const BIG_PDF_PAGES = 1200;
export const LOCKED_PDF_PASSWORD = 'lookglass';

/**
 * big.pdf: 1,200 uncompressed pages (~20 MB).
 *
 * Each page carries real drawing operators, so reaching a page near the end by
 * range requests must fetch a small fraction of the file. It also has an
 * outline, an internal link from page 1 to page 600, and a search needle on
 * page 1,100 — deep enough that search has to stream through the document.
 */
function bigPdf() {
  const pdf = new PdfBuilder();
  const catalog = pdf.reserve();
  const pagesRoot = pdf.reserve();
  const outlines = pdf.reserve();
  const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  // Reserve every page first so a link on page 1 can point at page 600.
  const pageNums = Array.from({ length: BIG_PDF_PAGES }, () => pdf.reserve());

  pageNums.forEach((num, index) => {
    const pageNumber = index + 1;
    const ops = [`BT /F1 28 Tf 72 740 Td ${literal(`Page ${pageNumber}`)} Tj ET`];
    if (pageNumber === 1) ops.push(`BT /F1 14 Tf 72 700 Td ${literal('Go to page 600')} Tj ET`);
    if (pageNumber === 1100) {
      ops.push(`BT /F1 14 Tf 72 700 Td ${literal('needle-marker on page eleven hundred')} Tj ET`);
    }
    // Filler geometry, so each page body has real weight.
    for (let row = 0; row < 420; row++) {
      const y = 660 - (row % 60) * 10;
      const x = 72 + (row % 7) * 64;
      ops.push(`${x} ${y} m ${x + 48} ${y} l S`);
    }
    const content = pdf.add('<< >>', ops.join('\n'));

    let annots = '';
    if (pageNumber === 1) {
      const link = pdf.add(
        `<< /Type /Annot /Subtype /Link /Rect [70 695 190 715] /Border [0 0 0] /Dest [${pageNums[599]} 0 R /Fit] >>`,
      );
      annots = ` /Annots [${link} 0 R]`;
    }

    pdf.set(
      num,
      `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R${annots} >>`,
    );
  });

  pdf.set(
    pagesRoot,
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${BIG_PDF_PAGES} >>`,
  );

  // Outline: one entry per 100 pages.
  const entries = Array.from({ length: 12 }, () => pdf.reserve());
  entries.forEach((num, index) => {
    const prev = index > 0 ? ` /Prev ${entries[index - 1]} 0 R` : '';
    const next = index < entries.length - 1 ? ` /Next ${entries[index + 1]} 0 R` : '';
    pdf.set(
      num,
      `<< /Title ${literal(`Part ${index + 1} (page ${index * 100 + 1})`)} /Parent ${outlines} 0 R /Dest [${pageNums[index * 100]} 0 R /Fit]${prev}${next} >>`,
    );
  });
  pdf.set(outlines, `<< /Type /Outlines /First ${entries[0]} 0 R /Last ${entries.at(-1)} 0 R /Count 12 >>`);
  pdf.set(catalog, `<< /Type /Catalog /Pages ${pagesRoot} 0 R /Outlines ${outlines} 0 R /PageMode /UseOutlines >>`);
  const info = pdf.add(`<< /Title ${literal('Large fixture document')} /Author ${literal('lookglass')} >>`);

  return pdf.build({ root: catalog, info });
}

/**
 * cjk.pdf: Japanese text in a non-embedded CID font.
 *
 * The text only extracts if PDF.js can load the UniJIS-UCS2-H and
 * Adobe-Japan1-UCS2 CMaps. Missing CMap assets are the classic cause of blank
 * CJK text, so this fixture proves they are served — including offline.
 */
function cjkPdf() {
  const pdf = new PdfBuilder();
  const catalog = pdf.reserve();
  const pagesRoot = pdf.reserve();
  const descriptor = pdf.add(
    '<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
  );
  const cidFont = pdf.add(
    `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor ${descriptor} 0 R /DW 1000 >>`,
  );
  const font = pdf.add(
    `<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [${cidFont} 0 R] >>`,
  );
  const latin = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  // 日本語のテキスト as UCS-2 big-endian.
  const japanese = Buffer.from('日本語のテキスト', 'utf16le').swap16().toString('hex').toUpperCase();
  const content = pdf.add(
    '<< >>',
    `BT /F1 20 Tf 72 720 Td ${literal('CJK fixture')} Tj ET\nBT /F2 32 Tf 72 660 Td <${japanese}> Tj ET`,
  );
  const page = pdf.add(
    `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${latin} 0 R /F2 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
  );
  pdf.set(pagesRoot, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  pdf.set(catalog, `<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`);
  return pdf.build({ root: catalog });
}

/** locked.pdf: RC4-encrypted with a user password. */
function lockedPdf() {
  const pdf = new PdfBuilder();
  const catalog = pdf.reserve();
  const pagesRoot = pdf.reserve();
  const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const content = pdf.add('<< >>', 'BT /F1 28 Tf 72 700 Td (Secret unlocked page) Tj ET');
  const page = pdf.add(
    `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
  );
  pdf.set(pagesRoot, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  pdf.set(catalog, `<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`);
  return pdf.build({ root: catalog, userPassword: LOCKED_PDF_PASSWORD });
}

/**
 * archive.zip: a plain ZIP with no Office parts. Nothing renders ZIPs, so it
 * exercises the unsupported-format path now that PDFs render.
 */
function plainZip() {
  const name = Buffer.from('readme.txt');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

export async function writePdfFixtures(root) {
  await writeFile(join(root, 'big.pdf'), bigPdf());
  await writeFile(join(root, 'cjk.pdf'), cjkPdf());
  await writeFile(join(root, 'locked.pdf'), lockedPdf());
  await writeFile(join(root, 'archive.zip'), plainZip());
}
