/// <reference lib="webworker" />
import { registerLookglassSw } from './index.js';

/**
 * Prebuilt service worker for apps that do not already have one.
 *
 * Build output is `dist/lookglass-sw.js`; copy it to `public/sw.js` (the
 * `lookglass-copy-assets` script does this for you) and register it with
 * `registerServiceWorker()`.
 *
 * The build injects `__LOOKGLASS_VERSION__` and `__LOOKGLASS_PRECACHE__`, so
 * the cache generation changes with every build automatically.
 */
declare const __LOOKGLASS_VERSION__: string;
declare const __LOOKGLASS_PRECACHE__: string[];

registerLookglassSw({
  version: __LOOKGLASS_VERSION__,
  precache: __LOOKGLASS_PRECACHE__,
  assetBasePath: '/lookglass',
  // The standalone worker is for apps with no service worker of their own, so
  // it owns the whole offline story including the app shell.
  navigationFallback: true,
});
