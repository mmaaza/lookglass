'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { BaseController } from '../../core/controller.js';
import type { SurfaceProps } from '../../core/renderer.js';
import type { DocState, FitMode } from '../../types.js';
import { extractText, rangeFor, type DocxItem, type TextMap } from './layout.js';

export interface DocxSurfaceConfig {
  items: DocxItem[];
  controller: BaseController;
  /** docx-preview's class prefix for this document. */
  className: string;
  /** The document's sanitised stylesheet. */
  css: string;
  anchors: Map<string, number>;
}

/** Space between pages, and the minimum margin beside them, in CSS pixels. */
const GAP = 16;
const GUTTER = 24;

/** Something to bring into view once its page is mounted. */
type Reveal = { item: number; start: number; end: number } | { item: number; anchor: string };

/**
 * Word pages in a shadow root, mounted only while visible.
 *
 * The shadow root is a security boundary, not decoration. The document's
 * stylesheet is generated from names inside the file; however well it is
 * sanitised, it is applied only within this root and cannot restyle the
 * host application. It also keeps the host app's CSS off the document, so
 * pages look the same in every app that embeds the viewer.
 *
 * Zoom uses CSS `zoom`, which scales layout rather than painting a
 * transformed box, so measured page heights and text selection stay right.
 */
export function createDocxSurface(config: DocxSurfaceConfig) {
  const { items, controller, className, css, anchors } = config;
  const chromeCss = buildChromeCss(className);
  const textMaps = new WeakMap<HTMLElement, TextMap>();
  const textMap = (index: number): TextMap => {
    const node = items[index]!.node;
    let map = textMaps.get(node);
    if (!map) {
      map = extractText(node);
      textMaps.set(node, map);
    }
    return map;
  };
  const widest = items.slice(0, 50).reduce((max, item) => Math.max(max, item.width), 0);
  const reference = { width: widest || items[0]!.width, height: items[0]!.height };
  const highlights = { match: `${className}-match`, active: `${className}-active` };

  return function DocxSurface({ className: surfaceClass }: SurfaceProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    const [root] = useState(() => {
      const element = document.createElement('div');
      element.className = `${className}-wrapper`;
      element.setAttribute('data-root', '');
      return element;
    });
    const state = useControllerState(controller);
    const box = useElementSize(scrollRef);

    useLayoutEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `${chromeCss}\n${css}`;
      shadow.replaceChildren(style, root);
      return () => shadow.replaceChildren();
    }, [root]);

    const { fit, zoom } = state.viewport;
    const scale = resolveScale(fit, zoom, box, reference);
    useEffect(() => {
      if (fit !== 'none') controller.setEffectiveZoom(scale);
    }, [fit, scale]);

    const virtualizer = useVirtualizer({
      count: items.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => Math.round(items[index]!.height * scale) + gapAfter(items[index]!),
      overscan: 2,
      paddingStart: GAP,
    });

    useLayoutEffect(() => {
      virtualizer.measure();
    }, [scale, virtualizer]);

    // Keep the same page in view across zoom changes.
    const anchor = useRef(state.page);
    useLayoutEffect(() => {
      virtualizer.scrollToIndex(anchor.current - 1, { align: 'start' });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scale]);

    // Navigation moves the view; pages reached by scrolling only update the
    // counter.
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

    // ---- reveal: bring a search hit or link target into view ----------
    const reveal = useRef<Reveal | null>(null);
    // Bumped to re-run the reveal effect when nothing else would re-render,
    // such as a link to a place on the page already in view.
    const [, setRevealTick] = useState(0);
    const activeHit = state.search.hits[state.search.activeIndex];
    useEffect(() => {
      const parsed = activeHit ? parseHitId(activeHit.id) : undefined;
      if (parsed) reveal.current = parsed;
    }, [activeHit?.id]);

    const virtualItems = virtualizer.getVirtualItems();
    const first = virtualItems[0]?.index ?? 0;
    const last = virtualItems[virtualItems.length - 1]?.index ?? -1;

    useEffect(() => {
      const target = reveal.current;
      if (!target || target.item < first || target.item > last) return;
      let attempts = 0;
      let frame = 0;
      const step = () => {
        const scroller = scrollRef.current;
        if (!scroller || reveal.current !== target) return;
        const rect = targetRect(target);
        if (!rect) {
          if (++attempts < 10) frame = requestAnimationFrame(step);
          return;
        }
        const view = scroller.getBoundingClientRect();
        const inView = rect.top >= view.top + 8 && rect.bottom <= view.bottom - 8;
        if (!inView) {
          scroller.scrollTop += rect.top - view.top - scroller.clientHeight / 3;
        }
        // The virtualiser may still be settling measured heights after a
        // jump, so check again for a few frames before letting go.
        if (++attempts < 4 || (!inView && attempts < 30)) frame = requestAnimationFrame(step);
        else reveal.current = null;
      };
      frame = requestAnimationFrame(step);
      return () => cancelAnimationFrame(frame);
    });

    // ---- search highlights ----------------------------------------------
    const hits = state.search.hits;
    const activeId = activeHit?.id;
    useEffect(() => {
      const registry = highlightRegistry();
      if (!registry) return;
      const matches: Range[] = [];
      const active: Range[] = [];
      for (const hit of hits) {
        const parsed = parseHitId(hit.id);
        if (!parsed || parsed.item < first || parsed.item > last) continue;
        if (!items[parsed.item]!.node.isConnected) continue;
        const range = rangeFor(textMap(parsed.item), parsed.start, parsed.end);
        if (!range) continue;
        (hit.id === activeId ? active : matches).push(range);
      }
      registry.set(highlights.match, new Highlight(...matches));
      registry.set(highlights.active, new Highlight(...active));
    }, [hits, activeId, first, last]);
    useEffect(
      () => () => {
        highlightRegistry()?.delete(highlights.match);
        highlightRegistry()?.delete(highlights.active);
      },
      [],
    );

    // ---- links ----------------------------------------------------------
    useEffect(() => {
      const onClick = (event: MouseEvent) => {
        const link = (event.target as Element | null)?.closest?.('a');
        if (!link) return;
        const href = link.getAttribute('href');
        if (!href) {
          event.preventDefault();
          return;
        }
        if (!href.startsWith('#')) return;
        event.preventDefault();
        const id = safeDecode(href.slice(1));
        const index = anchors.get(id);
        if (index === undefined) return;
        reveal.current = { item: index, anchor: id };
        controller.goToPage(index + 1);
        setRevealTick((tick) => tick + 1);
      };
      root.addEventListener('click', onClick);
      return () => root.removeEventListener('click', onClick);
    }, [root]);

    const contentWidth = Math.max(box.width, reference.width * scale + GUTTER * 2);

    return (
      <div
        ref={scrollRef}
        className={surfaceClass}
        data-lookglass-surface="docx"
        role="document"
        aria-label={`Word document, ${items.length} pages`}
        tabIndex={0}
        onScroll={onScroll}
        style={{ overflow: 'auto', height: '100%', position: 'relative' }}
      >
        <div
          ref={hostRef}
          data-lookglass-docx-host=""
          style={{ height: virtualizer.getTotalSize(), width: contentWidth, position: 'relative' }}
        />
        {createPortal(
          virtualItems.map((virtual) => {
            const item = items[virtual.index]!;
            return (
              <div
                key={virtual.key}
                data-index={virtual.index}
                ref={virtualizer.measureElement}
                className="lg-item"
                data-part={item.part}
                style={{ transform: `translateY(${virtual.start}px)`, paddingBottom: gapAfter(item) }}
              >
                <div
                  className="lg-page"
                  part="page"
                  data-lookglass-page-index={virtual.index + 1}
                  style={{ zoom: scale }}
                  ref={mountNode(item.node)}
                />
              </div>
            );
          }),
          root,
        )}
      </div>
    );

    function targetRect(target: Reveal): DOMRect | undefined {
      const node = items[target.item]?.node;
      if (!node?.isConnected) return undefined;
      if ('anchor' in target) {
        const element = node.querySelector(`[id="${cssString(target.anchor)}"]`);
        return element?.getBoundingClientRect();
      }
      const rects = rangeFor(textMap(target.item), target.start, target.end)?.getClientRects();
      return rects && rects.length > 0 ? rects[0] : undefined;
    }
  };
}

/**
 * Ref callbacks that move a detached page into its slot. Cached per node so
 * React sees a stable callback and does not detach and re-attach on every
 * render.
 */
const mountCallbacks = new WeakMap<HTMLElement, (slot: HTMLDivElement | null) => void>();
function mountNode(node: HTMLElement) {
  let callback = mountCallbacks.get(node);
  if (!callback) {
    callback = (slot) => {
      if (slot && node.parentNode !== slot) slot.replaceChildren(node);
    };
    mountCallbacks.set(node, callback);
  }
  return callback;
}

function gapAfter(item: DocxItem): number {
  return item.part === 'whole' || item.part === 'last' ? GAP : 0;
}

function parseHitId(id: string): { item: number; start: number; end: number } | undefined {
  const [item, start, length] = id.split(':').map(Number);
  if (![item, start, length].every((value) => Number.isInteger(value))) return undefined;
  return { item: item!, start: start!, end: start! + length! };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cssString(value: string): string {
  return value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ');
}

function highlightRegistry(): HighlightRegistry | undefined {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function' ? CSS.highlights : undefined;
}

function buildChromeCss(className: string): string {
  return `
:host { display: block; }
[data-root] { position: relative; height: 100%; display: block; padding: 0; background: none; }
.lg-item { position: absolute; top: 0; left: 0; width: 100%; box-sizing: border-box; display: flex; justify-content: center; }
.lg-page { color-scheme: light; }
.lg-page > section.${className} {
  background: #fff;
  color: #000;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.18), 0 0 0 1px rgb(0 0 0 / 0.05);
}
.lg-item[data-part="first"] > .lg-page > section { clip-path: inset(-8px -8px 0 -8px); }
.lg-item[data-part="middle"] > .lg-page > section { clip-path: inset(0 -8px); }
.lg-item[data-part="last"] > .lg-page > section { clip-path: inset(0 -8px -8px -8px); }
.lg-page a[href] { cursor: pointer; }
.lg-page img { max-width: none; }
::highlight(${className}-match) { background-color: var(--lg-match, #ffe68a); color: inherit; }
::highlight(${className}-active) { background-color: var(--lg-match-active, #ffb224); color: inherit; }
`;
}

function resolveScale(
  fit: FitMode,
  zoom: number,
  box: { width: number; height: number },
  page: { width: number; height: number },
): number {
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
