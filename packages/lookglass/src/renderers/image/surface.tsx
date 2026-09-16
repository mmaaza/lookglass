'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BaseController } from '../../core/controller.js';
import type { ScopedMemory } from '../../core/memory.js';
import type { SurfaceProps } from '../../core/renderer.js';
import type { DocState } from '../../types.js';

export interface ImageSurfaceConfig {
  controller: BaseController;
  memory: ScopedMemory;
  intrinsic: { width: number; height: number };
  /** Set only for animated formats, which render through an <img>. */
  objectUrl?: string;
  animated: boolean;
}

export function createImageSurface(config: ImageSurfaceConfig) {
  const { controller, memory, intrinsic, objectUrl, animated } = config;

  return function ImageSurface({ className }: SurfaceProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const state = useControllerState(controller);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const size = useElementSize(containerRef);

    const rotated = state.viewport.rotation % 180 !== 0;
    const contentWidth = rotated ? intrinsic.height : intrinsic.width;
    const contentHeight = rotated ? intrinsic.width : intrinsic.height;

    // Fit modes are resolved here rather than in the controller because only
    // the surface knows its own box.
    const fitScale = computeFit(state.viewport.fit, size, { width: contentWidth, height: contentHeight });
    const scale = fitScale ?? state.viewport.zoom;

    useLayoutEffect(() => {
      if (animated) return;
      const canvas = canvasRef.current;
      const bitmap = memory.get<ImageBitmap>('bitmap');
      if (!canvas || !bitmap) return;

      // Cap the backing store at the displayed size times DPR. Painting a
      // 100 MP image into a 900 px box at full resolution is pure waste.
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      const cssWidth = Math.max(1, Math.round(contentWidth * scale));
      const cssHeight = Math.max(1, Math.round(contentHeight * scale));
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;

      const context = canvas.getContext('2d', { alpha: true });
      if (!context) return;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';

      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate((state.viewport.rotation * Math.PI) / 180);
      const drawWidth = intrinsic.width * scale * dpr;
      const drawHeight = intrinsic.height * scale * dpr;
      context.drawImage(bitmap, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    }, [scale, state.viewport.rotation, contentWidth, contentHeight]);

    // Re-centre whenever the fit changes so the image never drifts off-screen.
    useEffect(() => {
      setPan({ x: 0, y: 0 });
    }, [state.viewport.fit, state.viewport.rotation]);

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

      const onMove = (move: PointerEvent) => {
        setPan({ x: origin.x + (move.clientX - startX), y: origin.y + (move.clientY - startY) });
      };
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
      // Ctrl+wheel is the browser's own zoom gesture; intercept it so the
      // image zooms instead of the whole page.
      event.preventDefault();
      const current = controller.getState().viewport.zoom;
      controller.setZoom(current * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, []);

    return (
      <div
        ref={containerRef}
        className={className}
        data-lookglass-surface="image"
        role="img"
        aria-label={`Image, ${intrinsic.width} by ${intrinsic.height} pixels`}
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
        <div style={{ transform: `translate(${pan.x}px, ${pan.y}px)`, lineHeight: 0 }}>
          {animated && objectUrl ? (
            <img
              src={objectUrl}
              alt=""
              style={{
                width: intrinsic.width * scale,
                height: intrinsic.height * scale,
                transform: `rotate(${state.viewport.rotation}deg)`,
              }}
            />
          ) : (
            <canvas ref={canvasRef} data-lookglass-canvas="" />
          )}
        </div>
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
  // 'page': fit entirely, but never upscale a small image to fill the frame.
  return Math.min(scaleX, scaleY, 1);
}

function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const box = entry.contentRect;
      setSize({ width: box.width, height: box.height });
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
