#!/usr/bin/env node
/**
 * Generate the demo corpus.
 *
 * Kept out of git: large fixtures belong in the build, not the repository.
 * `app.log` is deliberately big enough that a non-virtualised viewer would
 * visibly struggle with it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'files');
await mkdir(root, { recursive: true });

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

// 1x1 transparent PNG, enough to prove the image path end to end.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
await writeFile(join(root, 'logo.png'), png);

// A real PDF header so detection identifies it and the missing-renderer path
// is exercised honestly until M2 lands.
await writeFile(join(root, 'report.pdf'), '%PDF-1.7\n% placeholder until the PDF renderer lands\n');

console.log(`fixtures written to ${root}`);
