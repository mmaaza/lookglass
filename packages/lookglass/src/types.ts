/**
 * Shared, side-effect-free types. This module is safe to import from a server
 * component or a Node script: it contains no DOM access and no runtime deps.
 */

/** Every format lookglass can classify. `unknown` is always a valid outcome. */
export type FormatKind =
  | 'pdf'
  | 'image'
  | 'svg'
  | 'docx'
  | 'doc'
  | 'xlsx'
  | 'xls'
  | 'csv'
  | 'pptx'
  | 'ppt'
  | 'text'
  | 'json'
  | 'jsonl'
  | 'xml'
  | 'markdown'
  | 'unknown';

/** How a format was determined, in descending order of trust. */
export type DetectionMethod = 'magic' | 'container' | 'content' | 'mime' | 'extension' | 'fallback';

export interface DetectedFormat {
  kind: FormatKind;
  /** Best-guess MIME type. May differ from the one the transport claimed. */
  mime: string;
  /** Lower-cased extension without the dot, when we had a filename. */
  ext?: string;
  /** 0..1. Anything below 0.5 should be surfaced to the user as a guess. */
  confidence: number;
  method: DetectionMethod;
  /** Human-readable label for the chrome, e.g. "PDF document". */
  label: string;
  /** Set when the declared type disagreed with the bytes on disk. */
  mismatch?: { claimed: string; actual: FormatKind };
}

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

/**
 * What a renderer can actually do. The shared chrome reads this to decide
 * which controls to mount — never hard-code per-format branches in the UI.
 */
export interface Capabilities {
  /** Document is paginated and `pageCount` is meaningful. */
  pages: boolean;
  /** Supports `controller.search()`. */
  search: boolean;
  /** Honours `viewport.zoom`. */
  zoom: boolean;
  /** Honours `viewport.rotation`. */
  rotate: boolean;
  /** Content is real selectable text (not a canvas raster). */
  textSelect: boolean;
  /** Supports `controller.outline()`. */
  outline: boolean;
  /** Has a thumbnail strip worth showing (slides, pages). */
  thumbnails: boolean;
  /** Renders sheet-like tabs (workbooks). */
  sheets: boolean;
  /** Browser print produces a faithful result. */
  print: boolean;
}

export const NO_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  pages: false,
  search: false,
  zoom: false,
  rotate: false,
  textSelect: false,
  outline: false,
  thumbnails: false,
  sheets: false,
  print: false,
});

/* ------------------------------------------------------------------ *
 * Document metadata
 * ------------------------------------------------------------------ */

export interface DocMeta {
  kind: FormatKind;
  capabilities: Capabilities;
  /** 1 for single-surface documents (an image, a text file). */
  pageCount: number;
  /**
   * Noun for one unit of `pageCount`, lower-case singular. Text documents
   * count lines and slide decks count slides, and the chrome should say so
   * rather than calling everything a page.
   */
  pageLabel?: string;
  title?: string;
  author?: string;
  /** Intrinsic size of page 1 in CSS pixels, when the format has one. */
  intrinsicSize?: { width: number; height: number };
  /** Named sub-surfaces: workbook sheets, or slide titles. */
  sheets?: string[];
  /**
   * Set when the renderer intentionally reduced fidelity to stay inside the
   * memory budget. The chrome shows this to the user — silent degradation is
   * worse than a visible warning.
   */
  degraded?: DegradationNotice;
  /** Free-form, renderer-specific extras surfaced in the details panel. */
  extra?: Record<string, string | number | boolean>;
}

export interface DegradationNotice {
  reason: 'size' | 'memory' | 'unsupported-feature' | 'truncated' | 'partial-parse';
  message: string;
  /** e.g. `{ rowsShown: 100000, rowsTotal: 4200000 }` */
  detail?: Record<string, number | string>;
}

export interface OutlineNode {
  id: string;
  title: string;
  page?: number;
  children?: OutlineNode[];
}

/* ------------------------------------------------------------------ *
 * Viewport + controller
 * ------------------------------------------------------------------ */

export type FitMode = 'width' | 'height' | 'page' | 'actual' | 'none';

export interface Viewport {
  /** 1 = 100%. Renderers clamp this to what they can afford. */
  zoom: number;
  /** Degrees, always one of 0 | 90 | 180 | 270. */
  rotation: 0 | 90 | 180 | 270;
  fit: FitMode;
}

export interface SearchHit {
  /** Stable identity so the chrome can key list items. */
  id: string;
  page: number;
  /** Text around the hit, for the results list. */
  excerpt: string;
  /** Character offset of the hit within `excerpt`. */
  excerptOffset: number;
  excerptLength: number;
}

export interface SearchState {
  query: string;
  hits: SearchHit[];
  activeIndex: number;
  /** True while a streaming search is still producing hits. */
  running: boolean;
  /** Set when the search stopped early (hit cap or budget). */
  truncated?: boolean;
}

export interface DocState {
  page: number;
  pageCount: number;
  viewport: Viewport;
  sheet: number;
  search: SearchState;
}

/** The single surface the shared chrome drives, for every format. */
export interface DocController {
  getState(): DocState;
  subscribe(listener: (state: DocState) => void): () => void;

  goToPage(page: number): void;
  nextPage(): void;
  prevPage(): void;

  setZoom(zoom: number): void;
  zoomIn(): void;
  zoomOut(): void;
  setFit(fit: FitMode): void;
  setRotation(rotation: number): void;
  rotateCw(): void;

  setSheet(index: number): void;

  /** No-op when `capabilities.search` is false. */
  search(query: string): Promise<void>;
  nextMatch(): void;
  prevMatch(): void;
  clearSearch(): void;
}

/* ------------------------------------------------------------------ *
 * Progress + errors
 * ------------------------------------------------------------------ */

export type LoadPhase =
  | 'idle'
  | 'resolving'
  | 'detecting'
  | 'fetching'
  | 'persisting'
  | 'parsing'
  | 'indexing'
  | 'rendering'
  | 'ready'
  | 'error'
  | 'cancelled';

export interface LoadProgress {
  phase: LoadPhase;
  /** 0..1 when known, otherwise undefined (indeterminate). */
  ratio?: number;
  bytesDone?: number;
  bytesTotal?: number;
  /** Short status for the UI, e.g. "Indexing 1.2M rows". */
  message?: string;
}

export type ViewerErrorCode =
  | 'unsupported-format'
  | 'renderer-missing'
  | 'too-large'
  | 'out-of-memory'
  | 'corrupt'
  | 'password-required'
  | 'password-wrong'
  | 'network'
  | 'range-unsupported'
  | 'aborted'
  | 'worker-failed'
  | 'storage-full'
  | 'internal';
