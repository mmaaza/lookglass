'use client';

import { registerRenderer } from '../core/registry.js';

let registered = false;

/**
 * Register the renderers that ship with lookglass.
 *
 * Each `load` is a dynamic import, so this call costs nothing at startup —
 * it only tells the registry where to find each chunk. The chunk itself is
 * fetched the first time a document of that kind is opened, or eagerly by
 * `warmCache()` when preparing for offline use.
 */
export function registerDefaultRenderers(): void {
  if (registered) return;
  registered = true;

  registerRenderer({
    id: 'lookglass/image',
    kinds: ['image'],
    load: async () => (await import('./image/index.js')).imageRenderer,
  });

  registerRenderer({
    id: 'lookglass/pdf',
    kinds: ['pdf'],
    load: async () => (await import('./pdf/index.js')).pdfRenderer,
  });

  registerRenderer({
    id: 'lookglass/docx',
    kinds: ['docx'],
    load: async () => (await import('./docx/index.js')).docxRenderer,
  });

  registerRenderer({
    id: 'lookglass/sheet',
    kinds: ['xlsx', 'xls', 'ods'],
    load: async () => (await import('./sheet/index.js')).sheetRenderer,
  });

  registerRenderer({
    id: 'lookglass/csv',
    kinds: ['csv'],
    load: async () => (await import('./csv/index.js')).csvRenderer,
  });

  registerRenderer({
    id: 'lookglass/json',
    kinds: ['json', 'jsonl'],
    load: async () => (await import('./json/index.js')).jsonRenderer,
  });

  registerRenderer({
    id: 'lookglass/xml',
    kinds: ['xml'],
    load: async () => (await import('./xml/index.js')).xmlRenderer,
  });

  registerRenderer({
    id: 'lookglass/markdown',
    kinds: ['markdown'],
    load: async () => (await import('./markdown/index.js')).markdownRenderer,
  });

  registerRenderer({
    id: 'lookglass/svg',
    kinds: ['svg'],
    load: async () => (await import('./svg/index.js')).svgRenderer,
  });

  registerRenderer({
    id: 'lookglass/text',
    kinds: ['text'],
    load: async () => (await import('./text/index.js')).textRenderer,
  });
}
