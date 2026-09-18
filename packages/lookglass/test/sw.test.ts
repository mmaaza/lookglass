import { describe, expect, it } from 'vitest';
import { isContentHashed } from '../src/sw/index.js';

describe('isContentHashed', () => {
  it.each([
    '/_next/static/chunks/1933.dca65a69f8c38ac0.js',
    '/_next/static/chunks/app/page-4f3a2b1c9d8e7f60.js',
    '/_next/static/css/0a1b2c3d4e5f6a7b.css',
    '/_next/static/chunks/text-core-8f1e2d3c.js',
  ])('treats production output as immutable: %s', (path) => {
    expect(isContentHashed(path)).toBe(true);
  });

  it.each([
    // `next dev` names: these change content without changing URL. Serving
    // them cache-first is what pinned stale code in the playground.
    '/_next/static/chunks/app/page.js',
    '/_next/static/chunks/app-pages-internals.js',
    '/_next/static/chunks/main-app.js',
    '/_next/static/chunks/webpack.js',
    '/_next/static/development/_buildManifest.js',
    // Copied PDF.js assets change on a pdfjs-dist upgrade under the same name.
    '/lookglass/wasm/openjpeg.wasm',
    '/lookglass/cmaps/UniJIS-UCS2-H.bcmap',
    '/lookglass/standard_fonts/FoxitSans.pfb',
  ])('fetches unhashed files from the network first: %s', (path) => {
    expect(isContentHashed(path)).toBe(false);
  });
});
