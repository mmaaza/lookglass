'use client';

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BaseController } from '../../core/controller.js';
import { ViewerError } from '../../core/errors.js';
import type { OpenContext, OpenedDoc, RendererFactory, SurfaceProps } from '../../core/renderer.js';
import type { Capabilities, DegradationNotice, DocMeta, DocState } from '../../types.js';
import { readSvgSize, sanitizeSvg } from './sanitize.js';

const CAPABILITIES: Capabilities = {
  pages: false,
  search: false,
  zoom: true,
  rotate: true,
  textSelect: false,
  outline: false,
  thumbnails: false,
  sheets: false,
  print: true,
};

/** SVG is markup: a large one is a large DOM, which is the real cost here. */
const MAX_SVG_BYTES = 16 * 1024 * 1024;

/**
 * SVG viewer.
 *
 * Rendered inline rather than through an `<img>` so it stays crisp at any
 * zoom and its text remains selectable by assistive technology — which is
 * only safe because the markup is sanitised first. See `sanitize.ts`.
 */
export const svgRenderer: RendererFactory = {
  id: 'lookglass/svg',
  kinds: ['svg'],

  async open(ctx: OpenContext): Promise<OpenedDoc> {
    if (ctx.source.size > MAX_SVG_BYTES) {
      throw new ViewerError('too-large', `${ctx.source.name} is too large to render as inline SVG.`, {
        detail: { size: ctx.source.size, max: MAX_SVG_BYTES },
        retryable: false,
      });
    }

    ctx.onProgress({ phase: 'fetching', message: 'Reading image' });
    const bytes = await ctx.source.bytes({ maxBytes: MAX_SVG_BYTES, signal: ctx.token.signal });
    ctx.token.throwIfAborted();

    ctx.onProgress({ phase: 'parsing', message: 'Sanitising markup' });
    const markup = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const { html, removed, blockedRemote } = sanitizeSvg(markup);

    if (!html.includes('<svg')) {
      throw new ViewerError('corrupt', 'This file does not contain a usable SVG image.', { retryable: false });
    }

    const intrinsic = readSvgSize(html) ?? { width: 300, height: 150 };

    const controller = new BaseController({
      pageCount: 1,
      capabilities: CAPABILITIES,
      initialViewport: { fit: 'page', zoom: 1 },
    });

    const meta: DocMeta = {
      kind: 'svg',
      capabilities: CAPABILITIES,
      pageCount: 1,
      title: ctx.source.name,
      intrinsicSize: intrinsic,
      degraded: buildNotice(removed, blockedRemote),
      extra: { width: intrinsic.width, height: intrinsic.height, bytes: ctx.source.size },
    };

    const Surface = createSvgSurface({ html, controller, intrinsic });

    return {
      meta,
      controller,
      Surface,
      dispose: () => controller.dispose(),
    };
  },
};

function buildNotice(removed: string[], blockedRemote: number): DegradationNotice | undefined {
  const parts: string[] = [];
  if (removed.length > 0) {
    parts.push(`Removed unsafe markup: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? '…' : ''}.`);
  }
  if (blockedRemote > 0) {
    parts.push(
      `Blocked ${blockedRemote} reference${blockedRemote === 1 ? '' : 's'} to remote resources, so the image renders identically offline.`,
    );
  }
  if (parts.length === 0) return undefined;
  return { reason: 'unsupported-feature', message: parts.join(' ') };
}

function createSvgSurface(config: {
  html: string;
  controller: BaseController;
  intrinsic: { width: number; height: number };
}) {
  const { html, controller, intrinsic } = config;

  return function SvgSurface({ className }: SurfaceProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const state = useControllerState(controller);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [box, setBox] = useState({ width: 0, height: 0 });

    useLayoutEffect(() => {
      const element = containerRef.current;
      if (!element) return;
      const observer = new ResizeObserver(([entry]) => {
        if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
      });
      observer.observe(element);
      return () => observer.disconnect();
    }, []);

    const rotated = state.viewport.rotation % 180 !== 0;
    const contentWidth = rotated ? intrinsic.height : intrinsic.width;
    const contentHeight = rotated ? intrinsic.width : intrinsic.height;
    const scale = computeFit(state.viewport.fit, box, { width: contentWidth, height: contentHeight }) ?? state.viewport.zoom;

    const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      let origin = { x: 0, y: 0 };
      setPan((current) => {
        origin = current;
        return current;
      });

      const onMove = (move: PointerEvent) =>
        setPan({ x: origin.x + (move.clientX - startX), y: origin.y + (move.clientY - startY) });
      const onUp = () => {
        target.releasePointerCapture(event.pointerId);
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
      };
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
    }, []);

    const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      controller.setZoom(controller.getState().viewport.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, []);

    return (
      <div
        ref={containerRef}
        className={className}
        data-lookglass-surface="svg"
        role="img"
        aria-label="Vector image"
        onPointerDown={onPointerDown}
        onWheel={onWheel}
        style={{
          height: '100%',
          overflow: 'hidden',
          display: 'grid',
          placeItems: 'center',
          touchAction: 'none',
          cursor: 'grab',
        }}
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) rotate(${state.viewport.rotation}deg)`,
            width: intrinsic.width * scale,
            height: intrinsic.height * scale,
          }}
          // Sanitised above with DOMPurify's SVG profile plus remote-reference
          // stripping; nothing executable survives that pass.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  };
}

function computeFit(
  fit: DocState['viewport']['fit'],
  box: { width: number; height: number },
  content: { width: number; height: number },
): number | undefined {
  if (fit === 'none' || box.width === 0 || content.width === 0) return undefined;
  if (fit === 'actual') return 1;
  const scaleX = box.width / content.width;
  const scaleY = box.height / content.height;
  if (fit === 'width') return scaleX;
  if (fit === 'height') return scaleY;
  return Math.min(scaleX, scaleY);
}

function useControllerState(controller: BaseController): DocState {
  return useSyncExternalStore(
    (listener) => controller.subscribe(() => listener()),
    () => controller.getState(),
    () => controller.getState(),
  );
}

export default svgRenderer;
