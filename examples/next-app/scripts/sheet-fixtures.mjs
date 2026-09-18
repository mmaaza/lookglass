import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as XLSX from '../../../packages/lookglass/vendor/sheetjs/xlsx.mjs';

/**
 * Spreadsheet and CSV fixtures, each built to exercise something specific:
 * truncation past the row limit, merged cells, cached formula values, hidden
 * sheets, wide sheets, legacy and OpenDocument formats, HTML masquerading as
 * .xls, quoted CSV fields with embedded newlines, European delimiters and
 * UTF-16 text.
 */

export const ORDERS_ROWS = 120_000;
export const BIG_CSV_ROWS = 400_000;

const REGIONS = ['North', 'South', 'East', 'West'];
const PRODUCTS = ['Widget', 'Gadget', 'Sprocket', 'Doohickey', 'Gizmo'];

function workbook() {
  const wb = XLSX.utils.book_new();

  // Summary: merged title, currency and date formats, formulas whose cached
  // values must be shown (never recomputed).
  const summary = XLSX.utils.aoa_to_sheet([
    ['Quarterly sales summary'],
    [],
    ['Region', 'Units', 'Revenue', 'Updated', 'Share'],
    ...REGIONS.map((region, i) => [region, 1200 + i * 310, (1200 + i * 310) * 19.5, new Date(Date.UTC(2026, 2, 1 + i)), null]),
    ['Total', { t: 'n', f: 'SUM(B4:B7)', v: 6660 }, { t: 'n', f: 'SUM(C4:C7)', v: 129870 }],
  ], { cellDates: true });
  REGIONS.forEach((_, i) => {
    const row = 4 + i;
    summary[`E${row}`] = { t: 'n', f: `C${row}/C8`, v: ((1200 + i * 310) * 19.5) / 129870, z: '0.0%' };
    summary[`C${row}`].z = '"$"#,##0.00';
    summary[`D${row}`].z = 'yyyy-mm-dd';
  });
  summary.C8.z = '"$"#,##0.00';
  summary['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];
  summary['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 9 }];
  XLSX.utils.book_append_sheet(wb, summary, 'Summary');

  // Orders: more rows than the default parse limit, so truncation is visible,
  // with a search needle deep inside the part that is shown.
  const orders = [['Order', 'Date', 'Region', 'Product', 'Qty', 'Price', 'Note']];
  for (let i = 1; i <= ORDERS_ROWS; i++) {
    orders.push([
      `ORD-${String(i).padStart(6, '0')}`,
      new Date(Date.UTC(2026, 0, 1 + (i % 365))),
      REGIONS[i % 4],
      PRODUCTS[i % 5],
      (i % 40) + 1,
      Number(((i % 90) + 9.99).toFixed(2)),
      i === 90_000 ? 'needle-marker on order ninety thousand' : '',
    ]);
  }
  const ordersSheet = XLSX.utils.aoa_to_sheet(orders, { cellDates: true });
  ordersSheet['!cols'] = [{ wch: 12 }, { wch: 11 }, { wch: 8 }, { wch: 11 }, { wch: 5 }, { wch: 8 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ordersSheet, 'Orders');

  // Wide: 200 columns, past column Z, to exercise horizontal virtualisation.
  const wide = [Array.from({ length: 200 }, (_, c) => `Col ${c + 1}`)];
  for (let r = 1; r <= 300; r++) wide.push(Array.from({ length: 200 }, (_, c) => r * 1000 + c));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(wide), 'Wide');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['internal'], ['do not show by default']]), 'Hidden');
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }] };
  wb.Props = { Title: 'Sales workbook', Author: 'lookglass' };
  return wb;
}

function smallBook(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return wb;
}

function bigCsv() {
  const lines = ['id,region,product,qty,price,comment'];
  for (let i = 1; i <= BIG_CSV_ROWS; i++) {
    let comment = '';
    // Quoted fields with commas, escaped quotes and an embedded newline —
    // the cases that break naive line-based CSV readers.
    if (i % 1000 === 0) comment = `"note, with comma and ""quotes"""`;
    if (i === 12_345) comment = '"first line\nsecond line"';
    if (i === 350_000) comment = 'needle-marker deep in the csv';
    lines.push(`${i},${REGIONS[i % 4]},${PRODUCTS[i % 5]},${(i % 40) + 1},${((i % 90) + 9.99).toFixed(2)},${comment}`);
  }
  return `${lines.join('\n')}\n`;
}

function utf16le(text) {
  const out = Buffer.alloc(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) out.writeUInt16LE(text.charCodeAt(i), 2 + i * 2);
  return out;
}

export async function writeSheetFixtures(root) {
  await writeFile(join(root, 'sales.xlsx'), XLSX.write(workbook(), { type: 'buffer', bookType: 'xlsx', cellDates: true, compression: true }));

  const legacyRows = [['Name', 'City', 'Amount'], ['Zoë', 'Kraków', 12.5], ['Jürgen', 'Köln', 7]];
  await writeFile(join(root, 'legacy.xls'), XLSX.write(smallBook(legacyRows), { type: 'buffer', bookType: 'biff8' }));
  await writeFile(join(root, 'budget.ods'), XLSX.write(smallBook([['Item', 'Cost'], ['Rent', 1200], ['Food', 450]]), { type: 'buffer', bookType: 'ods' }));

  // An HTML table saved as .xls, as many web "Export to Excel" buttons do.
  await writeFile(
    join(root, 'export.xls'),
    '<html><body><table><tr><th>Ticket</th><th>Status</th></tr><tr><td>T-1</td><td>Open</td></tr><tr><td>T-2</td><td>Closed</td></tr></table></body></html>',
  );

  await writeFile(join(root, 'orders.csv'), bigCsv());
  await writeFile(join(root, 'european.csv'), 'Artikel;Preis;Menge\nSchraube;0,25;100\nMutter;0,10;250\nScheibe;0,05;500\n');
  await writeFile(join(root, 'unicode.tsv'), utf16le('Name\tCity\nZoë\tKraków\n李\t東京\n'));
}
