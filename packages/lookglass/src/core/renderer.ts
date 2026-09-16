import type { ComponentType } from 'react';
import type { ScopedMemory } from './memory.js';
import type { WorkerPool } from './worker-pool.js';
import type { LoadToken } from './cancel.js';
import type { Source } from '../source/types.js';
import type { DetectedFormat, DocController, DocMeta, FormatKind, LoadProgress } from '../types.js';

/**
 * The single contract every format implements.
 *
 * A renderer owns its own surface — PDF paints canvases, a workbook paints a
 * virtualised grid, JSON paints a tree — and exposes a uniform `DocController`
 * so the shared chrome (toolbar, search, keyboard, page nav) works for all of
 * them without per-format branching in the UI.
 */
export interface RendererFactory {
  id: string;
  kinds: FormatKind[];
  open(ctx: OpenContext): Promise<OpenedDoc>;
}

export interface OpenContext {
  source: Source;
  format: DetectedFormat;
  /** Aborts on unmount. Renderers must thread this through every await. */
  token: LoadToken;
  /** Per-document slice of the global byte budget. */
  memory: ScopedMemory;
  workers: WorkerPool;
  /** Cache key prefix / worker lease key, unique per open document. */
  docId: string;
  onProgress(update: LoadProgress): void;
  options: RendererOptions;
}

export interface RendererOptions {
  /**
   * Where copied runtime assets live (PDF.js cmaps and standard fonts).
   * Must be a same-origin path — fetching these from a CDN breaks offline.
   */
  assetBasePath: string;
  /** Whole-file read ceiling for renderers that cannot stream. */
  maxWholeFileBytes: number;
  /** Cap on device pixel ratio when rastering. Above ~2 the cost is wasted. */
  maxDevicePixelRatio: number;
  locale: string;
  /** Called when a document needs a password. Return null to cancel. */
  requestPassword?: (attempt: number) => Promise<string | null>;
  /** Renderer-specific escape hatch, keyed by renderer id. */
  rendererOptions?: Record<string, unknown>;
}

export const DEFAULT_RENDERER_OPTIONS: RendererOptions = {
  assetBasePath: '/lookglass',
  maxWholeFileBytes: 64 * 1024 * 1024,
  maxDevicePixelRatio: 2,
  locale: 'en',
};

export interface OpenedDoc {
  meta: DocMeta;
  controller: DocController;
  /**
   * The content surface. Created once per open and closed over the renderer's
   * own state, so it takes no props beyond presentation.
   */
  Surface: ComponentType<SurfaceProps>;
  dispose(): void | Promise<void>;
}

export interface SurfaceProps {
  className?: string;
}
