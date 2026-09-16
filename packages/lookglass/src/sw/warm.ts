'use client';

import { registry } from '../core/registry.js';
import { registerDefaultRenderers } from '../renderers/defaults.js';

export interface WarmCacheOptions {
  /** Where copied runtime assets live. Must match the service-worker config. */
  assetBasePath?: string;
  /** Extra same-origin URLs to pull into the cache. */
  extraAssets?: string[];
  signal?: AbortSignal;
}

export interface WarmCacheResult {
  renderers: { loaded: string[]; failed: string[] };
  assets: { cached: string[]; failed: string[] };
  /** App-shell entries the service worker cached for offline reloads. */
  shell: { cached: number; requested: number };
}

/**
 * Populate the offline cache on a first online visit.
 *
 * This exists because a build-time precache manifest cannot know the URLs of
 * lookglass's renderer chunks: the host app's bundler re-bundles and
 * content-hashes them, so their final names only exist in *its* output. The
 * reliable way to cache them is to import them once while online and let the
 * service worker observe the requests.
 *
 * Assets we do control — the copied PDF.js cmaps and fonts — have stable URLs
 * and are precached at install; they are re-fetched here only as a backstop.
 *
 * Call it after your app has finished its critical work, e.g. in an idle
 * callback, not during first paint.
 */
export async function warmCache(opts: WarmCacheOptions = {}): Promise<WarmCacheResult> {
  registerDefaultRenderers();

  const renderers = await registry.preloadAll();

  const assetBase = opts.assetBasePath ?? '/lookglass';
  const assets = [...(await discoverAssets(assetBase, opts.signal)), ...(opts.extraAssets ?? [])];

  const cached: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    assets.map(async (url) => {
      try {
        const response = await fetch(url, { signal: opts.signal });
        if (response.ok) {
          // Draining the body is what makes the service worker's fetch handler
          // complete and commit the entry.
          await response.arrayBuffer();
          cached.push(url);
        } else {
          failed.push(url);
        }
      } catch {
        failed.push(url);
      }
    }),
  );

  const shell = await warmShell(opts.signal);

  return { renderers, assets: { cached, failed }, shell };
}

/**
 * Ask the controlling service worker to cache the app shell this page is
 * running from.
 *
 * It has to go through the worker rather than `caches.open()` here: the cache
 * name is keyed to the worker's build version, which the page does not know,
 * and writing to a guessed name would strand the entries in a cache nothing
 * reads.
 */
async function warmShell(signal?: AbortSignal): Promise<{ cached: number; requested: number }> {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return { cached: 0, requested: 0 };

  const urls = new Set<string>([globalThis.location.href]);
  for (const entry of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    let url: URL;
    try {
      url = new URL(entry.name, globalThis.location.href);
    } catch {
      continue;
    }
    if (url.origin !== globalThis.location.origin) continue;
    // Scripts and stylesheets are what hydration needs; document fetches and
    // media are the app's own business.
    if (entry.initiatorType === 'script' || entry.initiatorType === 'link' || entry.initiatorType === 'css') {
      urls.add(url.href);
    }
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => resolve({ cached: 0, requested: urls.size }), 20_000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      const data = event.data as { cached?: number; requested?: number };
      resolve({ cached: data.cached ?? 0, requested: data.requested ?? urls.size });
    };
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve({ cached: 0, requested: urls.size });
    });
    controller.postMessage({ type: 'lookglass:warm', urls: [...urls] }, [channel.port2]);
  });
}

/**
 * Read the asset list written by `lookglass-copy-assets`.
 *
 * A missing manifest is normal before any format needing runtime assets is
 * installed, so it is not an error.
 */
async function discoverAssets(assetBase: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const response = await fetch(`${assetBase}/lookglass-precache.json`, { signal });
    if (!response.ok) return [];
    const manifest = (await response.json()) as { assets?: string[] };
    return manifest.assets ?? [];
  } catch {
    return [];
  }
}

export interface RegisterSwOptions {
  /** Path to your service worker. Must be at a scope covering the viewer. */
  url?: string;
  scope?: string;
  /** Called when a new build is waiting. Prompt, then call `activate()`. */
  onUpdateReady?: (activate: () => void) => void;
}

/**
 * Register a service worker without the update footgun.
 *
 * A waiting worker is never activated automatically. Doing so swaps the cache
 * generation under a page that already holds the previous build's chunk URLs,
 * and the next lazy import fails. The app decides when a reload is acceptable.
 */
export async function registerServiceWorker(opts: RegisterSwOptions = {}): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;

  const registration = await navigator.serviceWorker.register(opts.url ?? '/sw.js', {
    scope: opts.scope ?? '/',
  });

  const notify = () => {
    const waiting = registration.waiting;
    if (!waiting || !opts.onUpdateReady) return;
    opts.onUpdateReady(() => {
      waiting.postMessage({ type: 'lookglass:skip-waiting' });
      // Reload once the new worker takes over, not before.
      navigator.serviceWorker.addEventListener('controllerchange', () => globalThis.location.reload(), { once: true });
    });
  };

  if (registration.waiting) notify();
  registration.addEventListener('updatefound', () => {
    registration.installing?.addEventListener('statechange', () => {
      if (registration.waiting) notify();
    });
  });

  return registration;
}
