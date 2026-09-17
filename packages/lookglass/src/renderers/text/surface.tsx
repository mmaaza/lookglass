'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { DocState } from '../../types.js';
import type { BaseController } from '../../core/controller.js';
import type { SurfaceProps } from '../../core/renderer.js';
import type { WireToken } from '../../workers/highlight.js';
import { BLOCK_LINES, type LineStore } from './line-store.js';

export interface TextSurfaceConfig {
  store: LineStore;
  controller: BaseController;
  lineCount: number;
  /** Rendered in the gutter; width scales with the largest line number. */
  showLineNumbers: boolean;
}

const LINE_HEIGHT = 20;
const OVERSCAN = 24;

export function createTextSurface(config: TextSurfaceConfig) {
  const { store, controller, lineCount, showLineNumbers } = config;

  return function TextSurface({ className }: SurfaceProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const state = useControllerState(controller);
    const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);

    const virtualizer = useVirtualizer({
      count: lineCount,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => LINE_HEIGHT * state.viewport.zoom,
      overscan: OVERSCAN,
    });

    const items = virtualizer.getVirtualItems();

    // Ask the worker for the blocks covering what is about to paint. Doing
    // this during render (rather than in an effect) means the request goes out
    // one frame earlier, which is visible on fast scrolls.
    const first = items[0]?.index ?? 0;
    const last = items[items.length - 1]?.index ?? 0;
    store.ensureRange(first - BLOCK_LINES, last + BLOCK_LINES);

    // `controller.page` is 1-based and drives scroll from search results and
    // the toolbar, so it is the one place the surface follows the controller.
    const targetLine = state.page - 1;
    const lastScrolled = useRef(-1);
    useEffect(() => {
      if (targetLine === lastScrolled.current) return;
      lastScrolled.current = targetLine;
      if (targetLine >= 0 && targetLine < lineCount) {
        virtualizer.scrollToIndex(targetLine, { align: 'center' });
      }
    }, [targetLine, virtualizer, lineCount]);

    const gutterWidth = showLineNumbers ? `${String(lineCount).length + 1}ch` : '0';
    const query = state.search.query;
    const activeHit = state.search.hits[state.search.activeIndex];

    return (
      <div
        ref={scrollRef}
        className={className}
        data-lookglass-surface="text"
        tabIndex={0}
        role="document"
        aria-label={`Text document, ${lineCount.toLocaleString()} lines`}
        style={{ overflow: 'auto', height: '100%', position: 'relative' }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
            fontSize: `${13 * state.viewport.zoom}px`,
          }}
        >
          {items.map((item) => {
            const line = store.getLine(item.index);
            const isActiveHit = activeHit ? activeHit.page - 1 === item.index : false;
            return (
              <div
                key={item.key}
                data-lookglass-line={item.index + 1}
                data-lookglass-active={isActiveHit || undefined}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                  display: 'flex',
                }}
              >
                {showLineNumbers ? (
                  <span data-lookglass-gutter="" style={{ width: gutterWidth, flex: '0 0 auto' }} aria-hidden="true">
                    {item.index + 1}
                  </span>
                ) : null}
                <span data-lookglass-line-content="" style={{ flex: '1 1 auto', whiteSpace: 'pre' }}>
                  {line === undefined ? (
                    <span data-lookglass-skeleton="" aria-hidden="true" />
                  ) : query ? (
                    // Search marks take precedence over syntax colour; mixing
                    // the two span trees is not worth the complexity.
                    highlight(line, query, version)
                  ) : (
                    renderTokens(store.getTokens(item.index)) ?? line
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };
}

/**
 * Coloured spans for one line. Colours travel as CSS custom properties so the
 * stylesheet, not JavaScript, picks the light or dark value — theme switches
 * need no re-render and no second tokenisation.
 */
function renderTokens(tokens: WireToken[] | undefined) {
  if (!tokens) return undefined;
  return tokens.map(([content, light, dark, fontStyle], index) => (
    <span
      // Tokens within a line never reorder, so the index is a stable key.
      key={index}
      data-lookglass-token=""
      style={
        {
          '--lg-hl-light': light || undefined,
          '--lg-hl-dark': dark || undefined,
          fontStyle: fontStyle & 1 ? 'italic' : undefined,
          fontWeight: fontStyle & 2 ? 600 : undefined,
          textDecoration: fontStyle & 4 ? 'underline' : undefined,
        } as React.CSSProperties
      }
    >
      {content}
    </span>
  ));
}

/** Subscribe a component to controller state without re-rendering the tree. */
function useControllerState(controller: BaseController): DocState {
  return useSyncExternalStore(
    (listener) => controller.subscribe(() => listener()),
    () => controller.getState(),
    () => controller.getState(),
  );
}

/**
 * Highlight query occurrences inside one already-rendered line.
 *
 * Only visible lines reach this function, so the cost is bounded by the
 * viewport rather than the document — the same reason search itself runs in
 * the worker and only the hit list comes back.
 */
function highlight(line: string, query: string, key: number) {
  const haystack = line.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle || !haystack.includes(needle)) return line;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    if (index > cursor) parts.push(line.slice(cursor, index));
    parts.push(
      <mark key={`${key}-${index}`} data-lookglass-match="">
        {line.slice(index, index + needle.length)}
      </mark>,
    );
    cursor = index + needle.length;
    index = haystack.indexOf(needle, cursor);
  }
  if (cursor < line.length) parts.push(line.slice(cursor));
  return parts;
}
