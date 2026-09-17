'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useDocState } from '../headless/use-doc-state.js';
import { useFileViewer, type UseFileViewerOptions } from '../headless/use-file-viewer.js';
import { formatBytes } from '../source/blob.js';
import type { ViewerError } from '../core/errors.js';
import { NO_CAPABILITIES, type Capabilities, type DocController } from '../types.js';
import { Toolbar } from './toolbar.js';

export interface FileViewerProps extends UseFileViewerOptions {
  className?: string;
  /** Hide the built-in toolbar to supply your own. State stays available. */
  hideToolbar?: boolean;
  /** Hide the bottom status bar. */
  hideStatusBar?: boolean;
  /** Replace the loading UI. */
  renderLoading?: (progress: { phase: string; message?: string; ratio?: number }) => React.ReactNode;
  /** Replace the error UI. `retry` is a no-op for non-retryable errors. */
  renderError?: (error: ViewerError, retry: () => void) => React.ReactNode;
  /** Shown when `source` is null. */
  renderEmpty?: () => React.ReactNode;
}

/**
 * Batteries-included viewer.
 *
 * Deliberately thin: all lifecycle logic lives in `useFileViewer`, and all
 * per-format behaviour lives behind the renderer's `Surface` and controller.
 * This component only arranges them and wires keyboard shortcuts — which is
 * why swapping it for custom chrome costs nothing.
 */
export function FileViewer({
  className,
  hideToolbar,
  hideStatusBar,
  renderLoading,
  renderError,
  renderEmpty,
  ...viewerOptions
}: FileViewerProps) {
  const viewer = useFileViewer(viewerOptions);
  const { doc, format, source, status, progress, error } = viewer;
  const rootRef = useRef<HTMLDivElement>(null);

  const capabilities = doc?.meta.capabilities ?? NO_CAPABILITIES;
  const controller = doc?.controller;

  // Live state, not `doc.meta`: meta is a snapshot from open time, and tree
  // documents change their row count every time a node is expanded.
  const docState = useDocState(controller);

  useKeyboardShortcuts(rootRef, controller, capabilities);

  const onDownload = useCallback(() => {
    if (!source) return;
    void (async () => {
      const blob = await source.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = source.name;
      anchor.click();
      // Revoking synchronously can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    })();
  }, [source]);

  const Surface = doc?.Surface;

  const statusText = useMemo(() => {
    if (!doc || !format || !source) return '';
    const parts = [format.label];
    if (source.size >= 0) parts.push(formatBytes(source.size));
    if (capabilities.pages) parts.push(`${docState.pageCount.toLocaleString()} ${plural(doc.meta.pageLabel ?? 'page')}`);
    if (viewer.fromCache) parts.push('offline copy');
    return parts.join(' · ');
  }, [doc, format, source, capabilities.pages, viewer.fromCache, docState.pageCount]);

  return (
    <div ref={rootRef} className={className} data-lookglass-root="" data-lookglass-status={status} tabIndex={-1}>
      {!hideToolbar && doc && controller ? (
        <Toolbar
          controller={controller}
          capabilities={capabilities}
          title={doc.meta.title ?? source?.name ?? ''}
          pageLabel={capitalise(doc.meta.pageLabel ?? 'page')}
          onDownload={onDownload}
          onPrint={() => globalThis.print()}
        />
      ) : null}

      {doc?.meta.degraded ? (
        <div data-lookglass-notice="" role="status">
          {doc.meta.degraded.message}
        </div>
      ) : null}

      {format?.mismatch ? (
        <div data-lookglass-notice="" data-lookglass-notice-kind="warning" role="status">
          This file is named as {format.mismatch.claimed} but its contents are {format.mismatch.actual}. Showing it as{' '}
          {format.label.toLowerCase()}.
        </div>
      ) : null}

      <div data-lookglass-content="">
        {status === 'idle' ? (
          (renderEmpty?.() ?? <div data-lookglass-empty="">No file selected</div>)
        ) : status === 'loading' ? (
          (renderLoading?.(progress) ?? <DefaultLoading progress={progress} />)
        ) : status === 'error' && error ? (
          (renderError?.(error, viewer.reload) ?? <DefaultError error={error} retry={viewer.reload} />)
        ) : Surface ? (
          <Surface className="lookglass-surface" />
        ) : null}
      </div>

      {!hideStatusBar && statusText ? (
        <div data-lookglass-statusbar="">
          <span>{statusText}</span>
        </div>
      ) : null}
    </div>
  );
}

function DefaultLoading({ progress }: { progress: { phase: string; message?: string; ratio?: number } }) {
  const percent = progress.ratio !== undefined ? Math.round(progress.ratio * 100) : undefined;
  return (
    <div data-lookglass-loading="" role="status" aria-live="polite">
      <div
        data-lookglass-progress=""
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Loading document"
      >
        <div data-lookglass-progress-bar="" style={{ width: percent !== undefined ? `${percent}%` : undefined }} />
      </div>
      <span>{progress.message ?? phaseLabel(progress.phase)}</span>
    </div>
  );
}

function DefaultError({ error, retry }: { error: ViewerError; retry: () => void }) {
  return (
    <div data-lookglass-error="" role="alert">
      <p data-lookglass-error-message="">{error.userMessage}</p>
      {error.retryable ? (
        <button type="button" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Good enough for the nouns renderers actually use: page, line, slide, row. */
function plural(word: string): string {
  return word.endsWith('s') ? word : `${word}s`;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'resolving':
      return 'Preparing';
    case 'detecting':
      return 'Identifying file type';
    case 'fetching':
      return 'Downloading';
    case 'persisting':
      return 'Saving for offline use';
    case 'parsing':
      return 'Parsing';
    case 'indexing':
      return 'Indexing';
    case 'rendering':
      return 'Rendering';
    default:
      return 'Loading';
  }
}

/**
 * Viewer-scoped shortcuts.
 *
 * Bound to the viewer root rather than the window so a page hosting several
 * viewers, or a viewer inside a form, does not hijack the user's typing.
 */
function useKeyboardShortcuts(
  ref: React.RefObject<HTMLElement | null>,
  controller: DocController | undefined,
  capabilities: Capabilities,
) {
  useEffect(() => {
    const element = ref.current;
    if (!element || !controller) return;

    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal keys while the user is typing in the toolbar or a form.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      const api = controller;
      const meta = event.ctrlKey || event.metaKey;
      switch (event.key) {
        case 'ArrowRight':
        case 'PageDown':
          if (!capabilities.pages) return;
          api.nextPage();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          if (!capabilities.pages) return;
          api.prevPage();
          break;
        case 'Home':
          if (!capabilities.pages) return;
          api.goToPage(1);
          break;
        case 'End':
          if (!capabilities.pages) return;
          api.goToPage(api.getState().pageCount);
          break;
        case '+':
        case '=':
          if (!meta || !capabilities.zoom) return;
          api.zoomIn();
          break;
        case '-':
          if (!meta || !capabilities.zoom) return;
          api.zoomOut();
          break;
        case '0':
          if (!meta || !capabilities.zoom) return;
          api.setZoom(1);
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    element.addEventListener('keydown', handler);
    return () => element.removeEventListener('keydown', handler);
  }, [ref, controller, capabilities.pages, capabilities.zoom]);
}
