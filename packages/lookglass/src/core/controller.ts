import type { Capabilities, DocController, DocState, FitMode, SearchHit, SearchState, Viewport } from '../types.js';

/**
 * Shared implementation of `DocController`.
 *
 * Every renderer gets page/zoom/rotation/sheet state for free and overrides
 * only what it does differently — in practice just `runSearch`. This is what
 * keeps the chrome format-agnostic: the toolbar talks to this object, never
 * to a renderer directly.
 */

export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];
const MIN_ZOOM = ZOOM_STEPS[0]!;
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

export interface BaseControllerOptions {
  pageCount: number;
  capabilities: Capabilities;
  initialViewport?: Partial<Viewport>;
  /**
   * Runs the format's own search. Return hits in document order; call
   * `emit` repeatedly for streaming results on large documents so the first
   * hits appear before the scan finishes.
   */
  runSearch?: (query: string, emit: (hits: SearchHit[]) => void, signal: AbortSignal) => Promise<{ truncated?: boolean }>;
  /** Notified whenever page/sheet/viewport changes so the surface can react. */
  onChange?: (state: DocState) => void;
}

const EMPTY_SEARCH: SearchState = { query: '', hits: [], activeIndex: -1, running: false };

export class BaseController implements DocController {
  private state: DocState;
  private readonly listeners = new Set<(state: DocState) => void>();
  private searchAbort: AbortController | undefined;
  private syncedPage = 0;
  private readonly opts: BaseControllerOptions;

  constructor(opts: BaseControllerOptions) {
    this.opts = opts;
    this.state = {
      page: 1,
      pageCount: Math.max(1, opts.pageCount),
      sheet: 0,
      viewport: {
        zoom: 1,
        rotation: 0,
        fit: 'width',
        ...opts.initialViewport,
      },
      search: EMPTY_SEARCH,
    };
  }

  getState(): DocState {
    return this.state;
  }

  subscribe(listener: (state: DocState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Renderers call this when the page count becomes known after opening. */
  setPageCount(pageCount: number): void {
    this.patch({ pageCount: Math.max(1, pageCount), page: Math.min(this.state.page, Math.max(1, pageCount)) });
  }

  goToPage(page: number): void {
    if (!this.opts.capabilities.pages) return;
    const clamped = Math.max(1, Math.min(Math.round(page), this.state.pageCount));
    // Explicit navigation always moves the view, even back to a page that was
    // last reached by scrolling.
    this.syncedPage = 0;
    if (clamped !== this.state.page) this.patch({ page: clamped });
  }

  nextPage(): void {
    this.goToPage(this.state.page + 1);
  }

  prevPage(): void {
    this.goToPage(this.state.page - 1);
  }

  setZoom(zoom: number): void {
    if (!this.opts.capabilities.zoom) return;
    const clamped = Math.max(MIN_ZOOM, Math.min(zoom, MAX_ZOOM));
    // Any explicit zoom cancels fit-to-width, otherwise the next resize
    // would silently undo what the user just did.
    this.setViewport({ zoom: clamped, fit: 'none' });
  }

  zoomIn(): void {
    this.setZoom(ZOOM_STEPS.find((step) => step > this.state.viewport.zoom + 1e-6) ?? MAX_ZOOM);
  }

  zoomOut(): void {
    const below = [...ZOOM_STEPS].reverse().find((step) => step < this.state.viewport.zoom - 1e-6);
    this.setZoom(below ?? MIN_ZOOM);
  }

  setFit(fit: FitMode): void {
    this.setViewport({ fit });
  }

  setRotation(rotation: number): void {
    if (!this.opts.capabilities.rotate) return;
    const normalised = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
    this.setViewport({ rotation: normalised as Viewport['rotation'] });
  }

  rotateCw(): void {
    this.setRotation(this.state.viewport.rotation + 90);
  }

  /**
   * Record the page the user has scrolled to, without asking the surface to
   * scroll there. Surfaces call this from scroll handlers; `goToPage` is for
   * navigation that should move the view.
   */
  syncPage(page: number): void {
    const clamped = Math.max(1, Math.min(Math.round(page), this.state.pageCount));
    if (clamped !== this.state.page) {
      this.syncedPage = clamped;
      this.patch({ page: clamped });
    }
  }

  /** True when the current page came from `syncPage`, i.e. from scrolling. */
  pageFromScroll(): boolean {
    return this.syncedPage === this.state.page;
  }

  /**
   * Report the zoom a fit mode actually produced, so the toolbar shows a real
   * percentage. Unlike `setZoom` this keeps the fit mode.
   */
  setEffectiveZoom(zoom: number): void {
    if (Math.abs(zoom - this.state.viewport.zoom) < 0.001) return;
    this.patch({ viewport: { ...this.state.viewport, zoom } });
  }

  setSheet(index: number): void {
    if (index === this.state.sheet) return;
    // Sheets are independent documents as far as paging goes.
    this.patch({ sheet: Math.max(0, index), page: 1, search: EMPTY_SEARCH });
  }

  setViewport(patch: Partial<Viewport>): void {
    this.patch({ viewport: { ...this.state.viewport, ...patch } });
  }

  async search(query: string): Promise<void> {
    this.searchAbort?.abort();

    const trimmed = query.trim();
    if (!trimmed || !this.opts.capabilities.search || !this.opts.runSearch) {
      this.patch({ search: EMPTY_SEARCH });
      return;
    }

    const controller = new AbortController();
    this.searchAbort = controller;
    this.patch({ search: { query: trimmed, hits: [], activeIndex: -1, running: true } });

    const collected: SearchHit[] = [];
    const emit = (hits: SearchHit[]) => {
      if (controller.signal.aborted) return;
      collected.push(...hits);
      this.patch({
        search: {
          query: trimmed,
          hits: [...collected],
          // Jump to the first hit as soon as one exists, not at the end.
          activeIndex: collected.length > 0 ? Math.max(0, this.state.search.activeIndex) : -1,
          running: true,
        },
      });
    };

    try {
      const { truncated } = await this.opts.runSearch(trimmed, emit, controller.signal);
      if (controller.signal.aborted) return;
      this.patch({
        search: {
          query: trimmed,
          hits: collected,
          activeIndex: collected.length > 0 ? Math.max(0, this.state.search.activeIndex) : -1,
          running: false,
          truncated,
        },
      });
      const first = collected[Math.max(0, this.state.search.activeIndex)];
      if (first) this.goToPage(first.page);
    } catch (err) {
      if (controller.signal.aborted) return;
      this.patch({ search: { query: trimmed, hits: collected, activeIndex: -1, running: false } });
      throw err;
    } finally {
      if (this.searchAbort === controller) this.searchAbort = undefined;
    }
  }

  nextMatch(): void {
    this.stepMatch(1);
  }

  prevMatch(): void {
    this.stepMatch(-1);
  }

  clearSearch(): void {
    this.searchAbort?.abort();
    this.searchAbort = undefined;
    this.patch({ search: EMPTY_SEARCH });
  }

  dispose(): void {
    this.searchAbort?.abort();
    this.listeners.clear();
  }

  private stepMatch(delta: number): void {
    const { hits, activeIndex } = this.state.search;
    if (hits.length === 0) return;
    const next = (activeIndex + delta + hits.length) % hits.length;
    this.patch({ search: { ...this.state.search, activeIndex: next } });
    const hit = hits[next];
    if (hit) this.goToPage(hit.page);
  }

  private patch(partial: Partial<DocState>): void {
    this.state = { ...this.state, ...partial };
    this.opts.onChange?.(this.state);
    for (const listener of this.listeners) listener(this.state);
  }
}
