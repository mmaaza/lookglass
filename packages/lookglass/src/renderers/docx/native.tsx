'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { BaseController } from '../../core/controller.js';
import type { OpenContext, OpenedDoc, SurfaceProps } from '../../core/renderer.js';
import type { RpcClient } from '../../core/rpc.js';
import type { PageDisplay } from '../../ooxml/display.js';
import type { Capabilities, DocMeta, DocState, FitMode, OutlineNode, SearchHit } from '../../types.js';
import type { DocxWorkerHandlers } from '../../workers/docx.worker.js';
import { PAINT_CSS, paintPage, type ImageSource } from '../ooxml/paint.js';

/**
 * Word documents through lookglass's own layout engine.
 *
 * The worker parses the package, measures text with the document's fonts and
 * lays out pages; this side only paints finished display lists, one page at
 * a time, for the pages on screen. Pages appear while later ones are still
 * being laid out, and the page count grows until layout finishes.
 */

const CAPABILITIES: Capabilities = {
  pages: true,
  search: true,
  zoom: true,
  rotate: false,
  textSelect: true,
  outline: true,
  thumbnails: false,
  sheets: false,
  print: false,
};

const GAP = 16;
const GUTTER = 24;

export interface NativeDocxOptions {
  maxXmlBytes?: number;
}

export async function openNativeDocx(ctx: OpenContext, options: NativeDocxOptions): Promise<OpenedDoc> {
  const client = ctx.workers.lease<DocxWorkerHandlers>(
    ctx.docId,
    'docx',
    () => new Worker(new URL('../../workers/docx.worker.js', import.meta.url), { type: 'module' }),
  );
  ctx.token.onDispose(() => ctx.workers.release(ctx.docId));

  const descriptor = await ctx.source.descriptor();
  ctx.token.throwIfAborted();
  const opened = await client.call('open', { descriptor, maxXmlBytes: options.maxXmlBytes }, { signal: ctx.token.signal, onProgress: ctx.onProgress });

  // Embedded fonts, so painted text uses the faces layout measured.
  const faces: FontFace[] = [];
  for (const font of opened.fonts) {
    try {
      const face = new FontFace(font.family, font.data, { weight: font.weight, style: font.style });
      await face.load();
      document.fonts.add(face);
      faces.push(face);
    } catch (err) {
      console.warn('[lookglass] embedded font could not be used', font.family, err);
    }
  }
  ctx.token.onDispose(() => {
    for (const face of faces) document.fonts.delete(face);
  });

  const controller = new BaseController({
    pageCount: 1,
    capabilities: CAPABILITIES,
    initialViewport: { fit: 'width' },
    runSearch: async (query, emit, signal) => {
      const result = await client.call('search', { query }, { signal });
      emit(result.hits as SearchHit[]);
      return { truncated: result.truncated };
    },
  });

  const pages = new PageStore(client, opened.firstPage);
  let resolveOutline!: (nodes: OutlineNode[]) => void;
  const outline = new Promise<OutlineNode[]>((resolve) => (resolveOutline = resolve));

  // Layout runs for as long as it takes; pages are usable as soon as they exist.
  const layoutAbort = new AbortController();
  ctx.token.onDispose(() => layoutAbort.abort());
  let firstPage!: () => void;
  const firstPageReady = new Promise<void>((resolve) => (firstPage = resolve));
  const layoutDone = client
    .call('layout', undefined, {
      signal: layoutAbort.signal,
      onProgress: (update) => {
        if (update.items) {
          pages.setCount(update.items);
          controller.setPageCount(update.items);
          if (update.items >= 2) firstPage();
        }
      },
    })
    .then((result) => {
      pages.setCount(result.pages, true);
      controller.setPageCount(result.pages);
      resolveOutline(result.outline);
      firstPage();
      if (result.accuracy.wordBreaks > 0) {
        console.info(`[lookglass] docx layout: ${result.accuracy.matched}/${result.accuracy.wordBreaks} of Word's page breaks reproduced`);
      }
      // Development aid: set globalThis.__LOOKGLASS_DEBUG__ to log pagination against Word's.
      if ((globalThis as { __LOOKGLASS_DEBUG__?: boolean }).__LOOKGLASS_DEBUG__) {
        void client.call('diagnostics', undefined as never).then((report) => console.info('[lookglass] pagination', JSON.stringify(report)));
      }
      return result;
    });
  layoutDone.catch(() => firstPage());
  // Open resolves once the first page can be shown.
  await Promise.race([firstPageReady, layoutDone]);
  ctx.token.throwIfAborted();

  const images = new ImageCache(client);
  ctx.token.onDispose(() => images.dispose());

  const meta: DocMeta = {
    kind: 'docx',
    capabilities: CAPABILITIES,
    pageCount: pages.count,
    pageLabel: 'page',
    title: opened.title || ctx.source.name,
    author: opened.author,
    intrinsicSize: opened.firstPage,
    extra: {
      engine: 'lookglass',
      ...(opened.substitutedFonts.length > 0 ? { substitutedFonts: opened.substitutedFonts.join(', ') } : {}),
      ...Object.fromEntries(Object.entries(opened.unsupported).map(([key, count]) => [`unsupported.${key}`, count])),
    },
  };

  const Surface = createNativeSurface({ controller, pages, images, client });
  return {
    meta,
    controller,
    Surface,
    outline: () => outline,
    dispose: () => {
      layoutAbort.abort();
      controller.dispose();
      images.dispose();
      void client.call('close', undefined as never).catch(() => undefined);
      ctx.workers.release(ctx.docId);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Page and image caches
 * ------------------------------------------------------------------ */

const MAX_CACHED_PAGES = 24;

class PageStore {
  count = 1;
  complete = false;
  /** Changes when painted pages must be repainted (the final page count arrived). */
  epoch = 0;
  private readonly client: RpcClient<DocxWorkerHandlers>;
  private readonly cache = new Map<number, PageDisplay>();
  private readonly pending = new Map<number, Promise<PageDisplay>>();
  private readonly sizes = new Map<number, { width: number; height: number }>();
  private readonly fallback: { width: number; height: number };
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(client: RpcClient<DocxWorkerHandlers>, first: { width: number; height: number }) {
    this.client = client;
    this.fallback = first;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  setCount(count: number, complete = false): void {
    if (count === this.count && complete === this.complete) return;
    this.count = count;
    this.complete = complete;
    // Pages laid out before the total was known show "Page X of 99"; repaint with the real total.
    if (complete) {
      this.cache.clear();
      this.epoch++;
    }
    this.bump();
  }

  size(index: number): { width: number; height: number } {
    return this.sizes.get(index) ?? this.sizes.get(index - 1) ?? this.fallback;
  }

  peek(index: number): PageDisplay | undefined {
    const page = this.cache.get(index);
    if (page) {
      this.cache.delete(index);
      this.cache.set(index, page);
    }
    return page;
  }

  load(index: number): Promise<PageDisplay> {
    const cached = this.peek(index);
    if (cached) return Promise.resolve(cached);
    let pending = this.pending.get(index);
    if (!pending) {
      pending = this.client.call('page', { index }).then((page) => {
        this.cache.set(index, page);
        while (this.cache.size > MAX_CACHED_PAGES) this.cache.delete(this.cache.keys().next().value!);
        const previous = this.sizes.get(index);
        this.sizes.set(index, { width: page.width, height: page.height });
        if (!previous || previous.width !== page.width || previous.height !== page.height) this.bump();
        return page;
      });
      pending.finally(() => this.pending.delete(index)).catch(() => undefined);
      this.pending.set(index, pending);
    }
    return pending;
  }

  private bump(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

class ImageCache implements ImageSource {
  private readonly client: RpcClient<DocxWorkerHandlers>;
  private readonly urls = new Map<string, Promise<string | undefined>>();
  private disposed = false;

  constructor(client: RpcClient<DocxWorkerHandlers>) {
    this.client = client;
  }

  url(part: string): Promise<string | undefined> {
    let url = this.urls.get(part);
    if (!url) {
      url = this.client
        .call('part', { name: part })
        .then(({ bytes, type }) => {
          // Only image types become URLs; anything else is not shown.
          if (this.disposed || !/^image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml|avif|x-icon)$/i.test(type)) return undefined;
          return URL.createObjectURL(new Blob([bytes], { type }));
        })
        .catch(() => undefined);
      this.urls.set(part, url);
    }
    return url;
  }

  dispose(): void {
    this.disposed = true;
    for (const url of this.urls.values()) void url.then((value) => value && URL.revokeObjectURL(value));
    this.urls.clear();
  }
}

/* ------------------------------------------------------------------ *
 * Surface
 * ------------------------------------------------------------------ */

function createNativeSurface(config: { controller: BaseController; pages: PageStore; images: ImageCache; client: RpcClient<DocxWorkerHandlers> }) {
  const { controller, pages, images } = config;
  const highlightNames = { match: `lgw-match-${Math.random().toString(36).slice(2, 8)}`, active: '' };
  highlightNames.active = `${highlightNames.match}-active`;
  const chromeCss = `${PAINT_CSS}
:host { display: block; }
[data-root] { position: relative; height: 100%; }
.lg-item { position: absolute; top: 0; left: 0; width: 100%; display: flex; justify-content: center; }
.lg-painted { box-shadow: 0 1px 3px rgb(0 0 0 / 0.18), 0 0 0 1px rgb(0 0 0 / 0.05); }
::highlight(${highlightNames.match}) { background-color: var(--lg-match, #ffe68a); color: inherit; }
::highlight(${highlightNames.active}) { background-color: var(--lg-match-active, #ffb224); color: inherit; }
`;

  return function NativeDocxSurface({ className }: SurfaceProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    const [root] = useState(() => {
      const element = document.createElement('div');
      element.setAttribute('data-root', '');
      return element;
    });
    const state = useControllerState(controller);
    useSyncExternalStore(pages.subscribe, pages.getVersion, pages.getVersion);
    const box = useElementSize(scrollRef);

    useLayoutEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = chromeCss;
      shadow.replaceChildren(style, root);
      return () => shadow.replaceChildren();
    }, [root]);

    const reference = pages.size(0);
    const { fit, zoom } = state.viewport;
    const scale = resolveScale(fit, zoom, box, reference);
    useEffect(() => {
      if (fit !== 'none') controller.setEffectiveZoom(scale);
    }, [fit, scale]);

    const virtualizer = useVirtualizer({
      count: pages.count,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => Math.round(pages.size(index).height * scale) + GAP,
      overscan: 1,
      paddingStart: GAP,
    });

    useLayoutEffect(() => {
      virtualizer.measure();
    }, [scale, pages.getVersion(), virtualizer]);

    const anchor = useRef(state.page);
    useLayoutEffect(() => {
      virtualizer.scrollToIndex(anchor.current - 1, { align: 'start' });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scale]);

    useEffect(() => {
      anchor.current = state.page;
      if (controller.pageFromScroll()) return;
      virtualizer.scrollToIndex(state.page - 1, { align: 'start' });
    }, [state.page, virtualizer]);

    const onScroll = useCallback(() => {
      const element = scrollRef.current;
      if (!element) return;
      const item = virtualizer.getVirtualItemForOffset(element.scrollTop + element.clientHeight / 3);
      if (item) {
        anchor.current = item.index + 1;
        controller.syncPage(item.index + 1);
      }
    }, [virtualizer]);

    // Internal links: bookmarks resolve to pages in the worker's outline index.
    useEffect(() => {
      const onClick = (event: MouseEvent) => {
        const link = (event.target as Element | null)?.closest?.('a');
        const href = link?.getAttribute('href');
        if (!href || !href.startsWith('#')) return;
        event.preventDefault();
        void bookmarkPage(safeDecode(href.slice(1))).then((target) => {
          if (target !== undefined) controller.goToPage(target);
        });
      };
      root.addEventListener('click', onClick);
      return () => root.removeEventListener('click', onClick);
    }, [root]);

    const items = virtualizer.getVirtualItems();
    const hits = state.search.hits;
    const activeHit = hits[state.search.activeIndex];
    const [paintVersion, setPaintVersion] = useState(0);

    // Search highlights over painted text.
    useEffect(() => {
      const registry = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function' ? CSS.highlights : undefined;
      if (!registry) return;
      const matches: Range[] = [];
      const active: Range[] = [];
      const mounted = new Set(items.map((item) => item.index));
      for (const hit of hits) {
        const [page, offset, length] = hit.id.split(':').map(Number) as [number, number, number];
        if (!mounted.has(page)) continue;
        const pageRoot = root.querySelector(`[data-page="${page}"] .lg-text`);
        if (!pageRoot) continue;
        const range = rangeForOffset(pageRoot, offset, length);
        if (range) (hit === activeHit ? active : matches).push(range);
      }
      registry.set(highlightNames.match, new Highlight(...matches));
      registry.set(highlightNames.active, new Highlight(...active));
      // Scroll the active hit into view once its page is painted.
      if (activeHit && active[0]) {
        const scroller = scrollRef.current;
        const rect = active[0].getBoundingClientRect();
        const view = scroller?.getBoundingClientRect();
        if (scroller && view && (rect.top < view.top || rect.bottom > view.bottom)) {
          scroller.scrollTop += rect.top - view.top - scroller.clientHeight / 3;
        }
      }
    }, [hits, activeHit?.id, items.map((item) => item.index).join(','), paintVersion]);
    useEffect(
      () => () => {
        const registry = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : undefined;
        registry?.delete(highlightNames.match);
        registry?.delete(highlightNames.active);
      },
      [],
    );

    const contentWidth = Math.max(box.width, reference.width * scale + GUTTER * 2);

    return (
      <div
        ref={scrollRef}
        className={className}
        data-lookglass-surface="docx"
        data-lookglass-engine="lookglass"
        role="document"
        aria-label={`Word document, ${pages.count} pages`}
        tabIndex={0}
        onScroll={onScroll}
        style={{ overflow: 'auto', height: '100%', position: 'relative' }}
      >
        <div ref={hostRef} data-lookglass-docx-host="" style={{ height: virtualizer.getTotalSize(), width: contentWidth, position: 'relative' }} />
        {createPortal(
          items.map((item) => (
            <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="lg-item" style={{ transform: `translateY(${item.start}px)`, paddingBottom: GAP }}>
              <PageSlot index={item.index} scale={scale} onPainted={() => setPaintVersion((v) => v + 1)} />
            </div>
          )),
          root,
        )}
      </div>
    );
  };

  function PageSlot({ index, scale, onPainted }: { index: number; scale: number; onPainted: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const size = pages.size(index);
    useSyncExternalStore(pages.subscribe, pages.getVersion, pages.getVersion);
    const epoch = pages.epoch;
    useEffect(() => {
      let live = true;
      const element = ref.current;
      if (!element) return;
      const cached = pages.peek(index);
      if (cached) {
        paintPage(cached, element, images);
        onPainted();
        return;
      }
      void pages.load(index).then(
        (page) => {
          if (!live || !ref.current) return;
          paintPage(page, ref.current, images);
          onPainted();
        },
        () => undefined,
      );
      return () => {
        live = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [index, epoch]);
    return (
      <div style={{ zoom: scale, width: size.width, height: size.height }}>
        <div ref={ref} className="lg-painted" part="page" data-page={index} data-lookglass-page-index={index + 1} />
      </div>
    );
  }

  function bookmarkPage(name: string): Promise<number | undefined> {
    return config.client.call('bookmark', { name }).catch(() => undefined);
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A DOM range for `[offset, offset + length)` of a page's search text. */
function rangeForOffset(textLayer: Element, offset: number, length: number): Range | undefined {
  const spans = Array.from(textLayer.querySelectorAll<HTMLElement>('[data-s]'));
  let startNode: Text | undefined;
  let startOffset = 0;
  let endNode: Text | undefined;
  let endOffset = 0;
  const end = offset + length;
  for (const span of spans) {
    const s = Number(span.dataset.s);
    const node = span.firstChild as Text | null;
    if (!node) continue;
    const len = node.data.length;
    if (!startNode && offset >= s && offset <= s + len) {
      startNode = node;
      startOffset = offset - s;
    }
    if (startNode && end >= s && end <= s + len) {
      endNode = node;
      endOffset = end - s;
      break;
    }
  }
  if (!startNode || !endNode) return undefined;
  const range = document.createRange();
  range.setStart(startNode, Math.min(startOffset, startNode.data.length));
  range.setEnd(endNode, Math.min(endOffset, endNode.data.length));
  return range;
}

function resolveScale(fit: FitMode, zoom: number, box: { width: number; height: number }, page: { width: number; height: number }): number {
  if (box.width === 0 || page.width === 0) return zoom;
  const width = Math.max(1, box.width - GUTTER * 2);
  const height = Math.max(1, box.height - GAP * 2);
  const round = (value: number) => Math.max(0.1, Math.round(value * 100) / 100);
  switch (fit) {
    case 'width':
      return round(width / page.width);
    case 'height':
      return round(height / page.height);
    case 'page':
      return round(Math.min(width / page.width, height / page.height));
    case 'actual':
      return 1;
    default:
      return zoom;
  }
}

function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: element.clientWidth, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function useControllerState(controller: BaseController): DocState {
  return useSyncExternalStore(
    (listener) => controller.subscribe(() => listener()),
    () => controller.getState(),
    () => controller.getState(),
  );
}
