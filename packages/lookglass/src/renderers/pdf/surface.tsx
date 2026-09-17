'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import type { PDFPageProxy, PageViewport, TextLayer as TextLayerType } from 'pdfjs-dist';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BaseController } from '../../core/controller.js';
import { isAbort } from '../../core/errors.js';
import type { SurfaceProps } from '../../core/renderer.js';
import type { DocState, FitMode } from '../../types.js';
import type { PageLink, PdfPages } from './pages.js';

type PdfJs = typeof import('pdfjs-dist');

export interface PdfSurfaceConfig {
  pdfjs: PdfJs;
  pages: PdfPages;
  controller: BaseController;
}

/** Vertical gap between pages and horizontal gutter, in CSS pixels. */
const GAP = 12;
const GUTTER = 16;
/** Pages flying past during a fast scroll never start a render. */
const RENDER_DELAY_MS = 60;
/** The text layer is DOM-heavy, so it waits until the page has settled. */
const TEXT_LAYER_DELAY_MS = 180;

export function createPdfSurface(config: PdfSurfaceConfig) {
  const { pdfjs, pages, controller } = config;

  return function PdfSurface({ className }: SurfaceProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const state = useControllerState(controller);
    const version = useSyncExternalStore(pages.subscribe, pages.getVersion, pages.getVersion);
    const box = useElementSize(scrollRef);

    const { rotation, fit, zoom } = state.viewport;
    const rotated = rotation % 180 !== 0;
    const dims = useCallback(
      (pageNumber: number) => {
        const size = pages.sizeOf(pageNumber);
        return rotated ? { width: size.height, height: size.width } : size;
      },
      [rotated],
    );

    // Fit is resolved against the first page, not the current one. Following
    // the current page would change the zoom as the user scrolls from a
    // portrait page onto a landscape one — invalidating every cached raster
    // and yanking the scroll position mid-read.
    const reference = dims(1);
    const scale = resolveScale(fit, zoom, box, reference);

    useEffect(() => {
      if (fit !== 'none') controller.setEffectiveZoom(scale);
    }, [fit, scale]);

    const virtualizer = useVirtualizer({
      count: pages.pageCount,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => Math.round(dims(index + 1).height * scale) + GAP,
      overscan: 2,
      paddingStart: GAP,
    });

    // Scale, rotation and newly discovered page sizes all change item heights.
    useLayoutEffect(() => {
      virtualizer.measure();
    }, [scale, rotation, version, virtualizer]);

    // Keep the same page in view across zoom and rotation changes.
    const anchor = useRef(state.page);
    useLayoutEffect(() => {
      virtualizer.scrollToIndex(anchor.current - 1, { align: 'start' });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scale, rotation]);

    // Navigation (toolbar, keyboard, search, outline) moves the view; pages
    // reached by scrolling only update the counter.
    useEffect(() => {
      anchor.current = state.page;
      if (controller.pageFromScroll()) return;
      virtualizer.scrollToIndex(state.page - 1, { align: 'start' });
    }, [state.page, virtualizer]);

    const onScroll = useCallback(() => {
      const element = scrollRef.current;
      if (!element) return;
      // The page occupying the upper third is "current", matching how people
      // read: a page counts once they have started on it.
      const probe = element.scrollTop + element.clientHeight / 3;
      // Look the offset up across all measurements, not the rendered window:
      // this handler can run before the virtualiser has processed the same
      // scroll event, and its rendered items would still be the old range.
      const item = virtualizer.getVirtualItemForOffset(probe);
      if (item) {
        anchor.current = item.index + 1;
        controller.syncPage(item.index + 1);
      }
    }, [virtualizer]);

    const items = virtualizer.getVirtualItems();
    const widest = Math.max(...items.map((item) => dims(item.index + 1).width), reference.width);
    const contentWidth = Math.max(box.width, widest * scale + GUTTER * 2);

    const activeHit = state.search.hits[state.search.activeIndex];

    return (
      <div
        ref={scrollRef}
        className={className}
        data-lookglass-surface="pdf"
        role="document"
        aria-label={`PDF document, ${pages.pageCount} pages`}
        tabIndex={0}
        onScroll={onScroll}
        style={{ overflow: 'auto', height: '100%', position: 'relative' }}
      >
        <div style={{ height: virtualizer.getTotalSize(), width: contentWidth, position: 'relative' }}>
          {items.map((item) => {
            const pageNumber = item.index + 1;
            const size = dims(pageNumber);
            return (
              <div
                key={item.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                  display: 'flex',
                  justifyContent: 'center',
                }}
              >
                <PdfPage
                  pdfjs={pdfjs}
                  pages={pages}
                  controller={controller}
                  pageNumber={pageNumber}
                  scale={scale}
                  rotation={rotation}
                  width={Math.round(size.width * scale)}
                  height={Math.round(size.height * scale)}
                  query={state.search.query}
                  activeOffset={activeHit && activeHit.page === pageNumber ? hitOffset(activeHit.id) : undefined}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  };
}

interface PdfPageProps {
  pdfjs: PdfJs;
  pages: PdfPages;
  controller: BaseController;
  pageNumber: number;
  scale: number;
  rotation: number;
  width: number;
  height: number;
  query: string;
  /** Offset of the active search hit, when it is on this page. */
  activeOffset: number | undefined;
}

/**
 * One page: canvas raster, then text layer, search marks and links on top.
 *
 * Memoised because the parent re-renders on every scroll tick; a page should
 * only re-render when something about *it* changed.
 */
const PdfPage = memo(function PdfPage({
  pdfjs,
  pages,
  controller,
  pageNumber,
  scale,
  rotation,
  width,
  height,
  query,
  activeOffset,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);
  const [proxy, setProxy] = useState<PDFPageProxy | undefined>();
  const [links, setLinks] = useState<PageLink[]>([]);
  const [textReady, setTextReady] = useState(0);

  // ---- raster ------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setRendered(false);
    setFailed(false);

    const draw = (bitmap: ImageBitmap) => {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    };

    const exact = pages.cached(pageNumber, scale, rotation);
    if (exact) {
      draw(exact);
      pages.pin(pageNumber, scale, rotation);
      setRendered(true);
      return () => pages.unpin(pageNumber, scale, rotation);
    }

    // Show the closest cached scale stretched while the sharp one renders.
    const placeholder = pages.nearest(pageNumber, scale, rotation);
    if (placeholder) draw(placeholder);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      pages.render(pageNumber, scale, rotation, controller.signal).then(
        (bitmap) => {
          if (controller.signal.aborted) return;
          draw(bitmap);
          pages.pin(pageNumber, scale, rotation);
          setRendered(true);
        },
        (err: unknown) => {
          if (isAbort(err) || controller.signal.aborted) return;
          console.warn(`[lookglass] page ${pageNumber} failed to render`, err);
          setFailed(true);
        },
      );
    }, RENDER_DELAY_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
      pages.unpin(pageNumber, scale, rotation);
    };
  }, [pages, pageNumber, scale, rotation]);

  // ---- page proxy + links --------------------------------------------------
  useEffect(() => {
    let live = true;
    void pages.getPage(pageNumber).then(
      (page) => live && setProxy(page),
      () => undefined,
    );
    void pages.links(pageNumber).then(
      (found) => live && setLinks(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [pages, pageNumber]);

  const viewport: PageViewport | undefined = proxy?.getViewport({
    scale,
    rotation: (proxy.rotate + rotation) % 360,
  });

  // ---- text layer ------------------------------------------------------------
  useEffect(() => {
    const container = textRef.current;
    if (!container || !proxy || !viewport || !rendered) return;

    let layer: TextLayerType | undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      container.replaceChildren();
      layer = new pdfjs.TextLayer({
        textContentSource: proxy.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container,
        viewport,
      });
      layer.render().then(
        () => {
          if (cancelled) return;
          // Kept on the element so search highlighting can map offsets onto
          // spans without holding the TextLayer instance in React state.
          textLayers.set(container, { divs: layer!.textDivs, items: layer!.textContentItemsStr });
          setTextReady((value) => value + 1);
        },
        () => undefined,
      );
    }, TEXT_LAYER_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      layer?.cancel();
      textLayers.delete(container);
    };
    // `viewport` is derived from these; depending on the object would re-run
    // the layer on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxy, rendered, scale, rotation, pdfjs]);

  // ---- search highlighting ---------------------------------------------------
  useEffect(() => {
    const container = textRef.current;
    if (!container) return;
    const layer = textLayers.get(container);
    if (!layer) return;

    const active = highlightMatches(layer, query, activeOffset);
    // Bring the active match into view once its span exists; page-level
    // scrolling alone can leave it far below the fold on a tall page.
    active?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [query, activeOffset, textReady]);

  const followLink = useCallback(
    (link: PageLink) => {
      if (link.url) {
        window.open(link.url, '_blank', 'noopener,noreferrer');
        return;
      }
      if (link.dest) {
        void pages.resolveDestination(link.dest).then((target) => {
          if (target) controller.goToPage(target);
        });
      }
    },
    [pages, controller],
  );

  return (
    <div
      data-lookglass-page={pageNumber}
      data-lookglass-rendered={rendered || undefined}
      style={
        {
          position: 'relative',
          width,
          height,
          // Consumed by the PDF.js text layer to size and position its spans.
          '--total-scale-factor': scale,
          '--scale-round-x': '1px',
          '--scale-round-y': '1px',
        } as React.CSSProperties
      }
    >
      <canvas ref={canvasRef} aria-hidden="true" style={{ width, height, display: 'block' }} />
      <div ref={textRef} className="textLayer" data-lookglass-text-layer="" />
      {viewport
        ? links.map((link, index) => {
            const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(link.pdfRect) as number[];
            return (
              <a
                // Links on a page are static for its lifetime.
                key={index}
                data-lookglass-link={link.url ? 'external' : 'internal'}
                href={link.url ?? '#'}
                target={link.url ? '_blank' : undefined}
                rel={link.url ? 'noopener noreferrer' : undefined}
                aria-label={link.url ? `Link to ${link.url}` : 'Link within document'}
                onClick={(event) => {
                  event.preventDefault();
                  followLink(link);
                }}
                style={{
                  position: 'absolute',
                  left: Math.min(x1!, x2!),
                  top: Math.min(y1!, y2!),
                  width: Math.abs(x2! - x1!),
                  height: Math.abs(y2! - y1!),
                }}
              />
            );
          })
        : null}
      {failed ? (
        <div data-lookglass-page-error="" role="alert">
          Page {pageNumber} could not be rendered.
        </div>
      ) : null}
    </div>
  );
});

/* ------------------------------------------------------------------ *
 * Search highlighting
 * ------------------------------------------------------------------ */

interface LayerText {
  divs: HTMLElement[];
  items: string[];
}

const textLayers = new WeakMap<HTMLElement, LayerText>();

/**
 * Wrap query matches in `<mark>` inside the text layer's spans.
 *
 * Offsets are computed over the concatenated item strings, the same way the
 * search itself computes them, so a match spanning two spans is highlighted
 * in both and the active hit can be identified by offset. Spans are restored
 * from their original text first, so repeated searches never nest marks.
 *
 * @returns the element for the active match, if it is on this page.
 */
function highlightMatches(layer: LayerText, query: string, activeOffset: number | undefined): HTMLElement | undefined {
  const { divs, items } = layer;
  divs.forEach((div, index) => {
    if (div.dataset.lookglassMarked) {
      div.textContent = items[index] ?? '';
      delete div.dataset.lookglassMarked;
    }
  });

  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;

  const starts: number[] = [];
  let total = 0;
  for (const item of items) {
    starts.push(total);
    total += item.length;
  }
  const haystack = items.join('').toLowerCase();

  // Per-span list of [start, end, isActive] ranges, in local offsets.
  const ranges = new Map<number, [number, number, boolean][]>();
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    const end = at + needle.length;
    const active = at === activeOffset;
    for (let index = 0; index < items.length; index++) {
      const itemStart = starts[index]!;
      const itemEnd = itemStart + items[index]!.length;
      if (itemEnd <= at) continue;
      if (itemStart >= end) break;
      const list = ranges.get(index) ?? [];
      list.push([Math.max(at, itemStart) - itemStart, Math.min(end, itemEnd) - itemStart, active]);
      ranges.set(index, list);
    }
    at = haystack.indexOf(needle, end);
  }

  let activeElement: HTMLElement | undefined;
  for (const [index, list] of ranges) {
    const div = divs[index];
    const text = items[index];
    if (!div || text === undefined) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const [start, end, active] of list) {
      if (start > cursor) fragment.append(text.slice(cursor, start));
      const mark = document.createElement('mark');
      mark.setAttribute('data-lookglass-match', '');
      if (active) {
        mark.setAttribute('data-lookglass-active', '');
        activeElement ??= mark;
      }
      mark.textContent = text.slice(start, end);
      fragment.append(mark);
      cursor = end;
    }
    if (cursor < text.length) fragment.append(text.slice(cursor));
    div.replaceChildren(fragment);
    div.dataset.lookglassMarked = '1';
  }
  return activeElement;
}

function hitOffset(id: string): number {
  return Number(id.split(':')[1]);
}

/* ------------------------------------------------------------------ *
 * Layout helpers
 * ------------------------------------------------------------------ */

function resolveScale(
  fit: FitMode,
  zoom: number,
  box: { width: number; height: number },
  page: { width: number; height: number },
): number {
  if (box.width === 0 || page.width === 0) return zoom;
  const width = Math.max(1, box.width - GUTTER * 2);
  const height = Math.max(1, box.height - GAP * 2);
  // Rounded so tiny resize jitter does not invalidate every cached raster.
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
      // clientWidth excludes the scrollbar, which contentRect does not.
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
