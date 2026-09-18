#!/usr/bin/env node
/**
 * Generate the demo corpus.
 *
 * Kept out of git: large fixtures belong in the build, not the repository.
 * Each file is shaped to exercise something specific — sizes that a naive
 * implementation cannot handle, and structures that naive parsers get wrong.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePdfFixtures } from './pdf-fixtures.mjs';
import { writeSheetFixtures } from './sheet-fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'files');
await mkdir(root, { recursive: true });

const FENCE = '```';

/* ------------------------------- text -------------------------------- */

const LEVELS = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
const lines = [];
for (let i = 1; i <= 40_000; i++) {
  const level = LEVELS[i % LEVELS.length];
  const ts = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
  lines.push(`${ts} ${level.padEnd(5)} worker-${i % 8} request=${i} latency=${(i % 350) + 5}ms "GET /api/items/${i}"`);
  if (i % 5000 === 0) lines.push(`${ts} ERROR worker-${i % 8} needle-marker checkpoint reached at ${i}`);
}
await writeFile(join(root, 'app.log'), `${lines.join('\n')}\n`);

await writeFile(
  join(root, 'notes.txt'),
  [
    'lookglass demo notes',
    '====================',
    '',
    'Local files are read with Blob.slice - nothing is uploaded.',
    'Server files are fetched with HTTP range requests and cached to OPFS.',
    'Search runs in a worker; only visible lines are ever in the DOM.',
    '',
    'Try: pick app.log, search for "needle-marker", and watch memory stay flat.',
    '',
  ].join('\n'),
);

/* ------------------------------- JSON -------------------------------- */

// Large enough that JSON.parse would be the wrong tool, and nested enough to
// exercise expansion and path building.
const records = Array.from({ length: 25_000 }, (_, i) => ({
  id: i,
  sku: `SKU-${String(i).padStart(6, '0')}`,
  name: `Widget ${i}`,
  active: i % 3 !== 0,
  price: Number(((i % 500) + 0.99).toFixed(2)),
  tags: ['alpha', 'beta', 'gamma'].slice(0, (i % 3) + 1),
  supplier: {
    name: `Supplier ${i % 120}`,
    country: ['GB', 'DE', 'JP', 'US'][i % 4],
    rating: (i % 5) + 1,
  },
  notes: i % 5000 === 0 ? 'needle-marker deep inside the document' : null,
}));

await writeFile(
  join(root, 'catalog.json'),
  JSON.stringify({ generated: new Date(0).toISOString(), count: records.length, records }, null, 2),
);

await writeFile(
  join(root, 'events.jsonl'),
  `${Array.from({ length: 2000 }, (_, i) =>
    JSON.stringify({ ts: i, level: i % 7 === 0 ? 'error' : 'info', msg: `event ${i}` }),
  ).join('\n')}\n`,
);

/* -------------------------------- XML -------------------------------- */

// Includes the structures that break naive scanners: an attribute containing
// an escaped '>', CDATA holding markup, comments, and namespaced names.
const items = Array.from(
  { length: 4000 },
  (_, i) => `  <item id="${i}" expr="qty &gt; ${i % 10}" cat="c${i % 7}">
    <name>Item ${i}</name>
    <desc><![CDATA[<b>bold</b> & raw <markup>]]></desc>
    <price currency="GBP">${((i % 300) + 0.5).toFixed(2)}</price>
  </item>`,
).join('\n');

await writeFile(
  join(root, 'catalog.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!-- generated fixture -->
<catalog xmlns:x="http://example.com/x">
${items}
  <x:meta note="needle-marker in an attribute"/>
</catalog>
`,
);

/* ----------------------------- Markdown ------------------------------ */

const markdown = [
  '# lookglass guide',
  '',
  'A **markdown** fixture covering the features that matter.',
  '',
  '## Tables',
  '',
  '| Format | Renderer | Status |',
  '| --- | --- | --- |',
  '| JSON | offset tree | shipped |',
  '| XML | offset tree | shipped |',
  '| PDF | PDF.js | M2 |',
  '',
  '## Code',
  '',
  `${FENCE}ts`,
  'const viewer = <FileViewer source={file} />;',
  FENCE,
  '',
  '## Task list',
  '',
  '- [x] streaming scanners',
  '- [ ] PDF',
  '',
  '## Safety',
  '',
  'Raw HTML is sanitised: <img src=x onerror="alert(1)"> is rendered inert.',
  '',
  '> needle-marker lives in this blockquote.',
  '',
  ...Array.from({ length: 300 }, (_, i) => `Paragraph ${i} of filler, so the block virtualiser has work to do.\n`),
].join('\n');

await writeFile(join(root, 'guide.md'), markdown);

/* -------------------------------- SVG -------------------------------- */

// Carries every vector the sanitiser is expected to remove, so the demo
// proves the defence rather than asserting it.
await writeFile(
  join(root, 'diagram.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120">
  <script>alert('xss')</script>
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2b6cb0"/>
      <stop offset="1" stop-color="#6b46c1"/>
    </linearGradient>
  </defs>
  <rect width="200" height="120" fill="url(#g)"/>
  <circle cx="60" cy="60" r="30" fill="#ffffff" opacity="0.85" onclick="alert('xss')"/>
  <image href="https://evil.example/tracker.png" width="1" height="1"/>
  <text x="96" y="105" fill="#ffffff" font-family="sans-serif" font-size="14">sanitised</text>
</svg>
`,
);

/* ---------------------------- source code ---------------------------- */

// A block comment deliberately straddles the viewer's 512-line block
// boundary (lines 510-516, boundary after line 512). If grammar state were
// not carried between blocks, lines 513-516 would be coloured as code.
const source = [];
for (let i = 1; i <= 509; i++) source.push(`export const value${i}: number = ${i} * 2; // item ${i}`);
source.push('/*');
for (let i = 511; i <= 515; i++) source.push(`   comment line ${i}, still inside the block comment`);
source.push('*/ export const afterComment = "resumed";');
for (let i = 517; i <= 1200; i++) source.push(`function handler${i}(input: string): string { return input.trim(); }`);
await writeFile(join(root, 'widget.ts'), `${source.join('\n')}\n`);

/* ------------------------------ binary -------------------------------- */

// 1x1 transparent PNG, enough to prove the image path end to end.
await writeFile(
  join(root, 'logo.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/* ------------------------- PDF and unsupported ------------------------ */

await writePdfFixtures(root);
await writeSheetFixtures(root);

console.log(`fixtures written to ${root}`);
