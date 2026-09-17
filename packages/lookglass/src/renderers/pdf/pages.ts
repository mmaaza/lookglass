'use client';

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { ViewerError, abortError, isAbort } from '../../core/errors.js';
import { bitmapBytes, stringBytes, type ScopedMemory } from '../../core/memory.js';

/** Size of a page at scale 1 with its intrinsic rotation already applied. */
export interface PageSize {
  width: number;
  height: number;
}

export interface PageLink {
  /**
   * Rectangle in PDF user space. Kept raw so the page can map it through its
   * own viewport, which already accounts for zoom and rotation.
   */
  pdfRect: number[];
  url?: string;
  /** Named or explicit destination, resolved lazily on click. */
  dest?: string | unknown[];
}

export interface PageText {
  /** One string per text item, in the order the text layer creates its divs. */
  items: string[];
  /** Items joined with no separator; offsets index into this. */
  joined: string;
}

/**
 * Canvas area ceiling. Safari refuses larger backing stores and returns a
 * blank canvas instead of throwing, so the device pixel ratio is reduced for
 * very large pages rather than trusting the requested scale.
 */
const MAX_CANVAS_PIXELS = 16_777_216;
/** Rasterising is CPU- and memory-heavy; two at once keeps scrolling smooth. */
const MAX_CONCURRENT_RENDERS = 2;
/** Page proxies hold parsed resources; keep a window, clean the rest. */
const MAX_LIVE_PAGES = 40;

/**
 * Page access and rasterisation for one open PDF.
 *
 * Rendered pages are cached as `ImageBitmap`s in the shared byte budget, keyed
 * by scale and rotation. Scrolling back to a page is a `drawImage`, and
 * zooming shows the nearest cached bitmap stretched until the sharp one is
 * ready, instead of a blank rectangle.
 */
export class PdfPages {
  private readonly proxies = new Map<number, Promise<PDFPageProxy>>();
  private readonly sizes = new Map<number, PageSize>();
  private readonly pending = new Map<string, Promise<ImageBitmap>>();
  private readonly keysByPage = new Map<number, Set<string>>();
  private readonly listeners = new Set<() => void>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private revision = 0;
  private disposed = false;

  constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly memory: ScopedMemory,
    readonly defaultSize: PageSize,
    private readonly maxDevicePixelRatio: number,
  ) {
    this.sizes.set(1, defaultSize);
  }

  get pageCount(): number {
    return this.doc.numPages;
  }

  getVersion = (): number => this.revision;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Known size, or the first page's size as an estimate. */
  sizeOf(page: number): PageSize {
    return this.sizes.get(page) ?? this.defaultSize;
  }

  getPage(pageNumber: number): Promise<PDFPageProxy> {
    let proxy = this.proxies.get(pageNumber);
    if (!proxy) {
      proxy = this.doc.getPage(pageNumber).then((page) => {
        const viewport = page.getViewport({ scale: 1 });
        const known = this.sizes.get(pageNumber);
        if (!known || known.width !== viewport.width || known.height !== viewport.height) {
          this.sizes.set(pageNumber, { width: viewport.width, height: viewport.height });
          // Page sizes are discovered lazily; the surface re-measures on this.
          this.emit();
        }
        return page;
      });
      // A failed page must be retryable, not cached as a rejection.
      proxy.catch(() => this.proxies.delete(pageNumber));
      this.proxies.set(pageNumber, proxy);
      this.trimProxies(pageNumber);
    }
    return proxy;
  }

  /** Exact cached raster for these parameters, if present. */
  cached(pageNumber: number, scale: number, rotation: number): ImageBitmap | undefined {
    return this.memory.get<ImageBitmap>(this.key(pageNumber, scale, rotation));
  }

  /**
   * Any cached raster of this page at this rotation, closest in scale.
   * Used as a stretched placeholder while the sharp render is in flight.
   */
  nearest(pageNumber: number, scale: number, rotation: number): ImageBitmap | undefined {
    const keys = this.keysByPage.get(pageNumber);
    if (!keys) return undefined;
    let best: { bitmap: ImageBitmap; distance: number } | undefined;
    for (const key of keys) {
      const [, , keyRotation, keyScale] = key.split(':');
      if (Number(keyRotation) !== rotation) continue;
      const bitmap = this.memory.get<ImageBitmap>(key);
      if (!bitmap) {
        keys.delete(key);
        continue;
      }
      const distance = Math.abs(Number(keyScale) / 1000 - scale);
      if (!best || distance < best.distance) best = { bitmap, distance };
    }
    return best?.bitmap;
  }

  pin(pageNumber: number, scale: number, rotation: number): void {
    this.memory.pin(this.key(pageNumber, scale, rotation));
  }

  unpin(pageNumber: number, scale: number, rotation: number): void {
    this.memory.unpin(this.key(pageNumber, scale, rotation));
  }

  /**
   * Rasterise a page. Aborting the signal cancels the PDF.js render task,
   * which is what keeps a fast scroll through 500 pages from queueing 500
   * full renders behind the one the user actually stopped on.
   */
  render(pageNumber: number, scale: number, rotation: number, signal: AbortSignal): Promise<ImageBitmap> {
    const key = this.key(pageNumber, scale, rotation);
    const hit = this.memory.get<ImageBitmap>(key);
    if (hit) return Promise.resolve(hit);

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const work = this.withSlot(signal, async () => {
      const page = await this.getPage(pageNumber);
      signal.throwIfAborted();

      const base = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
      const pixelRatio = this.outputScale(base.width, base.height);
      const viewport = page.getViewport({ scale: scale * pixelRatio, rotation: (page.rotate + rotation) % 360 });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));

      const task = page.render({ canvas, viewport });
      const onAbort = () => task.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        await task.promise;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
      signal.throwIfAborted();

      const bitmap = await createImageBitmap(canvas);
      // Release the canvas backing store now rather than waiting for GC; at
      // 2x DPR a page is tens of megabytes.
      canvas.width = 0;
      canvas.height = 0;

      if (this.disposed) {
        bitmap.close();
        throw abortError();
      }

      // A rejected entry has already been disposed (closed) by the memory
      // manager, so returning it would hand the caller an unusable bitmap.
      if (!this.memory.set(key, bitmap, bitmapBytes(bitmap), (value) => value.close())) {
        throw new ViewerError('out-of-memory', 'This page is too large to render within the memory budget.', {
          detail: { page: pageNumber, width: bitmap.width, height: bitmap.height },
        });
      }
      let keys = this.keysByPage.get(pageNumber);
      if (!keys) {
        keys = new Set();
        this.keysByPage.set(pageNumber, keys);
      }
      keys.add(key);
      return bitmap;
    });

    this.pending.set(key, work);
    void work.finally(() => this.pending.delete(key)).catch(() => undefined);
    return work;
  }

  /** Text items for search and the text layer, cached in the byte budget. */
  async text(pageNumber: number, signal?: AbortSignal): Promise<PageText> {
    const key = `text:${pageNumber}`;
    const hit = this.memory.get<PageText>(key);
    if (hit) return hit;

    const page = await this.getPage(pageNumber);
    signal?.throwIfAborted();
    // Must match what the text layer produces, item for item: search offsets
    // computed here are mapped onto its spans for highlighting. The text layer
    // creates one span per item that has a string and skips marked-content
    // markers, and it renders without Unicode normalisation.
    const content = await page.getTextContent({ disableNormalization: true });
    const items = content.items.flatMap((item) => ('str' in item ? [item.str] : []));
    const text: PageText = { items, joined: items.join('') };
    this.memory.set(key, text, stringBytes(text.joined) * 2 + items.length * 16);
    return text;
  }

  async links(pageNumber: number): Promise<PageLink[]> {
    const page = await this.getPage(pageNumber);
    const annotations = (await page.getAnnotations({ intent: 'display' })) as {
      subtype?: string;
      rect?: number[];
      url?: string;
      unsafeUrl?: string;
      dest?: string | unknown[];
    }[];
    const out: PageLink[] = [];
    for (const annotation of annotations) {
      if (annotation.subtype !== 'Link' || !annotation.rect) continue;
      const url = safeUrl(annotation.url);
      if (!url && !annotation.dest) continue;
      out.push({ pdfRect: annotation.rect, url, dest: annotation.dest });
    }
    return out;
  }

  /** 1-based page number for a named or explicit destination. */
  async resolveDestination(dest: string | unknown[]): Promise<number | undefined> {
    try {
      const explicit = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
      const target = explicit?.[0];
      if (target === undefined || target === null) return undefined;
      if (typeof target === 'number') return target + 1;
      return (await this.doc.getPageIndex(target as never)) + 1;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    for (const proxy of this.proxies.values()) {
      void proxy.then((page) => page.cleanup()).catch(() => undefined);
    }
    this.proxies.clear();
    this.waiting.length = 0;
  }

  private key(pageNumber: number, scale: number, rotation: number): string {
    return `bmp:${pageNumber}:${rotation}:${Math.round(scale * 1000)}`;
  }

  /** Device pixel ratio for this render, reduced to stay under the canvas cap. */
  private outputScale(cssWidth: number, cssHeight: number): number {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, this.maxDevicePixelRatio);
    const area = cssWidth * cssHeight * dpr * dpr;
    return area > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)) : dpr;
  }

  private async withSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    while (this.active >= MAX_CONCURRENT_RENDERS) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      if (signal.aborted) {
        // This waiter was woken for a slot it no longer wants. Pass the wake
        // on, or the next queued render would wait for a release that already
        // happened.
        this.waiting.shift()?.();
        throw abortError();
      }
    }
    this.active++;
    try {
      return await work();
    } catch (err) {
      // PDF.js reports a cancelled render as its own exception type.
      if ((err as { name?: string })?.name === 'RenderingCancelledException') throw abortError();
      throw err;
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private trimProxies(keep: number): void {
    if (this.proxies.size <= MAX_LIVE_PAGES) return;
    // Drop the pages furthest from the one just requested.
    const victims = [...this.proxies.keys()]
      .sort((a, b) => Math.abs(b - keep) - Math.abs(a - keep))
      .slice(0, this.proxies.size - MAX_LIVE_PAGES);
    for (const pageNumber of victims) {
      const proxy = this.proxies.get(pageNumber);
      this.proxies.delete(pageNumber);
      void proxy?.then((page) => page.cleanup()).catch(() => undefined);
    }
  }

  private emit(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Only web and mail links are followed. `javascript:`, `file:` and custom
 * schemes embedded in a document are dropped rather than handed to the
 * browser.
 */
function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export { isAbort };
