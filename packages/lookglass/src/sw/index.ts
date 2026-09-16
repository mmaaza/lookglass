/// <reference lib="webworker" />

/**
 * Service-worker routes for offline viewing.
 *
 * This ships routes rather than a whole service worker because most apps
 * already have one, and two service workers cannot share a scope. Drop these
 * handlers into yours, or use the prebuilt `lookglass-sw.js` if you have none.
 *
 * What is cached here, and what is not:
 *
 *   - Renderer chunks and copied runtime assets -> Cache API, cache-first.
 *     Their URLs are content-hashed, so a stale entry is impossible.
 *   - Document bytes -> **not here**. They go to OPFS, which can serve byte
 *     ranges and does not need the whole file resident. Putting a 1 GB PDF in
 *     the Cache API would defeat every large-file property of this library.
 */

export interface LookglassSwConfig {
  /**
   * Build identity. Changing it starts a new cache generation; the previous
   * one is kept until clients reload so in-flight lazy imports still resolve.
   */
  version: string;
  /** Where `lookglass-copy-assets` put the PDF.js cmaps and fonts. */
  assetBasePath?: string;
  /** Stable asset URLs to fetch at install time. From the build manifest. */
  precache?: string[];
  /**
   * Content-hashed build output to cache on first use. The default matches
   * Next.js; Vite users want `/assets/`.
   */
  chunkPattern?: RegExp;
  /** Requests that must always go to the network. */
  bypassPattern?: RegExp;
  /** Cap on runtime-cached entries, so a long session cannot grow forever. */
  maxRuntimeEntries?: number;
  /**
   * Serve page navigations from cache when the network is unavailable.
   *
   * Off by default: taking over navigation requests is the host app's call,
   * not a viewer library's, and guessing wrong breaks routing in ways that
   * are painful to debug. Turn it on when lookglass is the offline story for
   * the whole app — without it, a reload with no network fails before any of
   * the cached chunks are reached.
   *
   * The strategy is network-first, so an online user always gets fresh HTML.
   */
  navigationFallback?: boolean;
}

export interface LookglassRoutes {
  onInstall(event: ExtendableEvent): void;
  onActivate(event: ExtendableEvent): void;
  /** Returns true when lookglass handled the request. */
  onFetch(event: FetchEvent): boolean;
  onMessage(event: ExtendableMessageEvent): void;
}

const PRECACHE_PREFIX = 'lookglass-precache-';
const RUNTIME_PREFIX = 'lookglass-runtime-';

export function createLookglassRoutes(config: LookglassSwConfig): LookglassRoutes {
  const assetBase = config.assetBasePath ?? '/lookglass';
  const chunkPattern = config.chunkPattern ?? /\/_next\/static\//;
  const maxRuntimeEntries = config.maxRuntimeEntries ?? 300;
  const precacheName = `${PRECACHE_PREFIX}${config.version}`;
  const runtimeName = `${RUNTIME_PREFIX}${config.version}`;

  const isNavigation = (request: Request): boolean =>
    config.navigationFallback === true && request.mode === 'navigate';

  const shouldHandle = (url: URL, request: Request): boolean => {
    if (request.method !== 'GET') return false;
    if (url.origin !== self.location.origin) return false;
    if (config.bypassPattern?.test(url.pathname)) return false;
    if (isNavigation(request)) return true;
    return chunkPattern.test(url.pathname) || url.pathname.startsWith(assetBase);
  };

  return {
    onInstall(event) {
      event.waitUntil(
        (async () => {
          if (!config.precache?.length) return;
          const cache = await caches.open(precacheName);
          // Individually, not `addAll`: one missing asset must not fail the
          // whole install and leave the app with no service worker at all.
          await Promise.all(
            config.precache.map(async (url) => {
              try {
                const response = await fetch(url, { cache: 'reload' });
                if (response.ok) await cache.put(url, response);
                else console.warn(`[lookglass sw] precache skipped ${url}: ${response.status}`);
              } catch (err) {
                console.warn(`[lookglass sw] precache failed ${url}`, err);
              }
            }),
          );
        })(),
      );
    },

    onActivate(event) {
      event.waitUntil(
        (async () => {
          const names = await caches.keys();
          const mine = names.filter((name) => name.startsWith(PRECACHE_PREFIX) || name.startsWith(RUNTIME_PREFIX));
          const generation = (name: string) => name.slice(name.indexOf('-', name.indexOf('-') + 1) + 1);
          const current = new Set([precacheName, runtimeName]);

          // Keep the immediately previous generation alive. A page loaded from
          // the old build still holds old chunk URLs, and deleting them mid
          // session is exactly what produces
          // "Failed to fetch dynamically imported module".
          const previous = mine
            .filter((name) => !current.has(name))
            .sort()
            .slice(-2);
          const keep = new Set([...current, ...previous]);

          await Promise.all(mine.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
          void generation;
        })(),
      );
    },

    onFetch(event) {
      const url = new URL(event.request.url);
      if (!shouldHandle(url, event.request)) return false;

      if (isNavigation(event.request)) {
        event.respondWith(
          (async () => {
            const runtime = await caches.open(runtimeName);
            try {
              const response = await fetch(event.request);
              // Network-first: an online reload must never show stale HTML.
              if (response.ok && response.type === 'basic') {
                await runtime.put(event.request, response.clone());
              }
              return response;
            } catch {
              const cached = await runtime.match(event.request);
              if (cached) return cached;
              // Fall back to any cached navigation, so a deep link still opens
              // the shell offline rather than the browser's error page.
              const keys = await runtime.keys();
              for (const key of keys) {
                if (new Request(key).mode === 'navigate' || new URL(key.url).pathname === '/') {
                  const fallback = await runtime.match(key);
                  if (fallback) return fallback;
                }
              }
              return new Response('Offline and this page has not been cached yet.', {
                status: 503,
                headers: { 'content-type': 'text/plain' },
              });
            }
          })(),
        );
        return true;
      }

      event.respondWith(
        (async () => {
          const precache = await caches.open(precacheName);
          const precached = await precache.match(event.request);
          if (precached) return precached;

          const runtime = await caches.open(runtimeName);
          const cached = await runtime.match(event.request);
          if (cached) return cached;

          try {
            const response = await fetch(event.request);
            // Opaque and error responses are not worth caching, and caching an
            // opaque response silently consumes a large storage quota padding.
            if (response.ok && response.type === 'basic') {
              await runtime.put(event.request, response.clone());
              void trimCache(runtime, maxRuntimeEntries);
            }
            return response;
          } catch (err) {
            // Offline with nothing cached: surface a clear signal so the
            // registry can report `renderer-missing` rather than a parse error.
            return new Response(
              JSON.stringify({ error: 'lookglass-offline-miss', url: url.pathname }),
              { status: 504, headers: { 'content-type': 'application/json' } },
            );
          }
        })(),
      );
      return true;
    },

    onMessage(event) {
      const data = event.data as { type?: string; urls?: string[] } | undefined;

      // Activation is explicit: the app decides when a reload is acceptable.
      if (data?.type === 'lookglass:skip-waiting') {
        void (self as unknown as ServiceWorkerGlobalScope).skipWaiting();
        return;
      }

      // The page asking us to cache the shell it is currently running from.
      //
      // This closes the first-visit gap: on the very first load the service
      // worker is not yet controlling the page, so the HTML and the initial
      // JS chunks are fetched without ever passing through `onFetch` and are
      // therefore absent from the cache. Without this, the first offline
      // reload serves cached HTML that cannot hydrate.
      if (data?.type === 'lookglass:warm' && Array.isArray(data.urls)) {
        const port = event.ports[0];
        event.waitUntil(
          (async () => {
            const runtime = await caches.open(runtimeName);
            let cached = 0;
            await Promise.all(
              data.urls!.map(async (url) => {
                try {
                  if (await runtime.match(url)) {
                    cached++;
                    return;
                  }
                  const response = await fetch(url, { credentials: 'same-origin' });
                  if (response.ok && response.type === 'basic') {
                    await runtime.put(url, response);
                    cached++;
                  }
                } catch {
                  /* offline or blocked; the next online visit retries */
                }
              }),
            );
            port?.postMessage({ type: 'lookglass:warmed', cached, requested: data.urls!.length });
          })(),
        );
      }
    },
  };
}

/** Attach the routes to a service worker scope. */
export function registerLookglassSw(
  config: LookglassSwConfig,
  scope: ServiceWorkerGlobalScope = self as unknown as ServiceWorkerGlobalScope,
): void {
  const routes = createLookglassRoutes(config);
  scope.addEventListener('install', (event) => routes.onInstall(event));
  scope.addEventListener('activate', (event) => {
    routes.onActivate(event);
    event.waitUntil(scope.clients.claim());
  });
  scope.addEventListener('fetch', (event) => {
    routes.onFetch(event);
  });
  scope.addEventListener('message', (event) => routes.onMessage(event));
}

async function trimCache(cache: Cache, max: number): Promise<void> {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  // Cache API preserves insertion order, so the front is the oldest.
  await Promise.all(keys.slice(0, keys.length - max).map((key) => cache.delete(key)));
}
