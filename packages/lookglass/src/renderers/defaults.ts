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
    id: 'lookglass/text',
    kinds: ['text'],
    load: async () => (await import('./text/index.js')).textRenderer,
  });
}
