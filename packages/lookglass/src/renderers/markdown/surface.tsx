'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { BaseController } from '../../core/controller.js';
import type { ScopedMemory } from '../../core/memory.js';
import { stringBytes } from '../../core/memory.js';
import type { RpcClient } from '../../core/rpc.js';
import type { SurfaceProps } from '../../core/renderer.js';
import type { DocState } from '../../types.js';
import type { MarkdownWorkerHandlers } from '../../workers/markdown.worker.js';

export interface MarkdownSurfaceConfig {
  client: RpcClient<MarkdownWorkerHandlers>;
  controller: BaseController;
  memory: ScopedMemory;
  blockCount: number;
}

const BLOCK_BATCH = 24;
/** Blocks vary wildly in height, so this is only a first guess. */
const ESTIMATED_BLOCK_HEIGHT = 80;

/**
 * Block-virtualised markdown.
 *
 * Heights are measured rather than assumed — a paragraph and a 200-row table
 * are both "one block" — so the virtualiser uses `measureElement` and the
 * scroll range settles as blocks are painted.
 *
 * `dangerouslySetInnerHTML` is safe here specifically because the HTML was
 * produced and sanitised in the worker against an allow-list; nothing
 * user-supplied reaches the DOM unfiltered.
 */
export function createMarkdownSurface(config: MarkdownSurfaceConfig) {
  const { client, controller, memory, blockCount } = config;

  const listeners = new Set<() => void>();
  let revision = 0;
  const pending = new Set<number>();

  const notify = () => {
    revision++;
    for (const listener of listeners) listener();
  };

  const ensureBatch = (batch: number) => {
    const key = `blocks:${batch}`;
    if (memory.has(key)) {
      memory.get(key);
      return;
    }
    if (pending.has(batch)) return;
    pending.add(batch);

    const start = batch * BLOCK_BATCH;
    void client
      .call('getBlocks', { start, end: Math.min(start + BLOCK_BATCH, blockCount) })
      .then((html) => {
        memory.set(key, html, html.reduce((sum, item) => sum + stringBytes(item), 0));
        notify();
      })
      .catch((err) => {
        if ((err as { name?: string })?.name !== 'AbortError') console.warn('[lookglass] markdown blocks failed', err);
      })
      .finally(() => pending.delete(batch));
  };

  const getBlock = (index: number): string | undefined => {
    const batch = Math.floor(index / BLOCK_BATCH);
    return memory.get<string[]>(`blocks:${batch}`)?.[index - batch * BLOCK_BATCH];
  };

  return function MarkdownSurface({ className }: SurfaceProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const state = useControllerState(controller);
    useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      () => revision,
      () => revision,
    );

    const virtualizer = useVirtualizer({
      count: blockCount,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ESTIMATED_BLOCK_HEIGHT,
      overscan: 6,
      measureElement: (element) => element.getBoundingClientRect().height,
    });

    const items = virtualizer.getVirtualItems();
    const first = items[0]?.index ?? 0;
    const last = items[items.length - 1]?.index ?? 0;
    for (let batch = Math.floor(first / BLOCK_BATCH); batch <= Math.floor(last / BLOCK_BATCH); batch++) {
      ensureBatch(batch);
    }

    const target = state.page - 1;
    const lastScrolled = useRef(-1);
    useEffect(() => {
      if (target === lastScrolled.current) return;
      lastScrolled.current = target;
      if (target >= 0 && target < blockCount) virtualizer.scrollToIndex(target, { align: 'start' });
    }, [target, virtualizer]);

    // Internal anchors must scroll the virtual list, not the (absent) DOM node.
    const onClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href') ?? '';
      if (!href.startsWith('#')) {
        // External links open in a new tab and must not leak the referrer.
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
        return;
      }
      event.preventDefault();
    }, []);

    return (
      <div
        ref={scrollRef}
        className={className}
        data-lookglass-surface="markdown"
        role="document"
        aria-label="Markdown document"
        tabIndex={0}
        onClick={onClick}
        style={{ overflow: 'auto', height: '100%' }}
      >
        <div
          data-lookglass-prose=""
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
            fontSize: `${16 * state.viewport.zoom}px`,
          }}
        >
          {items.map((item) => {
            const html = getBlock(item.index);
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-lookglass-block={item.index + 1}
                data-lookglass-active={target === item.index || undefined}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {html === undefined ? (
                  <p data-lookglass-skeleton="" aria-hidden="true" />
                ) : (
                  // Sanitised in the worker against an allow-list schema.
                  <div dangerouslySetInnerHTML={{ __html: html }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };
}

function useControllerState(controller: BaseController): DocState {
  return useSyncExternalStore(
    (listener) => controller.subscribe(() => listener()),
    () => controller.getState(),
    () => controller.getState(),
  );
}
