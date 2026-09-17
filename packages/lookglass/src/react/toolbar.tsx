'use client';

import { useEffect, useRef, useState } from 'react';
import { useDocState } from '../headless/use-doc-state.js';
import type { Capabilities, DocController } from '../types.js';

export interface ToolbarProps {
  controller: DocController;
  capabilities: Capabilities;
  title: string;
  /** Label for the paging control; "Page" for documents, "Line" for text. */
  pageLabel?: string;
  onDownload?: () => void;
  onPrint?: () => void;
  /** Shown when the document has an outline. */
  outlineOpen?: boolean;
  onToggleOutline?: () => void;
}

/**
 * Format-agnostic toolbar.
 *
 * Every control is gated on `capabilities`, never on the format, which is the
 * whole point of the controller contract — adding PPTX later lights up the
 * same buttons with no change here.
 */
export function Toolbar({
  controller,
  capabilities,
  title,
  pageLabel = 'Page',
  onDownload,
  onPrint,
  outlineOpen,
  onToggleOutline,
}: ToolbarProps) {
  const state = useDocState(controller);
  const [pageInput, setPageInput] = useState(String(state.page));
  const [query, setQuery] = useState('');

  // Follow the controller unless the field is focused, so search-driven page
  // jumps update the box without fighting the user's typing.
  const pageRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== pageRef.current) setPageInput(String(state.page));
  }, [state.page]);

  const commitPage = () => {
    const parsed = Number.parseInt(pageInput, 10);
    if (Number.isFinite(parsed)) controller.goToPage(parsed);
    else setPageInput(String(state.page));
  };

  return (
    <div data-lookglass-toolbar="" role="toolbar" aria-label="Document controls">
      {capabilities.outline && onToggleOutline ? (
        <button
          type="button"
          onClick={onToggleOutline}
          aria-pressed={outlineOpen ?? false}
          aria-label="Toggle outline"
          data-lookglass-outline-toggle=""
        >
          ☰
        </button>
      ) : null}
      <span data-lookglass-title="" title={title}>
        {title}
      </span>

      {capabilities.pages ? (
        <span data-lookglass-group="">
          <button type="button" onClick={() => controller.prevPage()} disabled={state.page <= 1} aria-label={`Previous ${pageLabel.toLowerCase()}`}>
            ‹
          </button>
          <input
            ref={pageRef}
            data-lookglass-page-input=""
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={commitPage}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitPage();
            }}
            inputMode="numeric"
            aria-label={`${pageLabel} number`}
          />
          <span data-lookglass-page-total="">/ {state.pageCount.toLocaleString()}</span>
          <button
            type="button"
            onClick={() => controller.nextPage()}
            disabled={state.page >= state.pageCount}
            aria-label={`Next ${pageLabel.toLowerCase()}`}
          >
            ›
          </button>
        </span>
      ) : null}

      {capabilities.zoom ? (
        <span data-lookglass-group="">
          <button type="button" onClick={() => controller.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" onClick={() => controller.setFit('width')} data-lookglass-zoom-level="">
            {Math.round(state.viewport.zoom * 100)}%
          </button>
          <button type="button" onClick={() => controller.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <select
            value={state.viewport.fit}
            onChange={(event) => controller.setFit(event.target.value as never)}
            aria-label="Fit mode"
          >
            <option value="width">Fit width</option>
            <option value="page">Fit page</option>
            <option value="actual">Actual size</option>
            <option value="none">Custom</option>
          </select>
        </span>
      ) : null}

      {capabilities.rotate ? (
        <button type="button" onClick={() => controller.rotateCw()} aria-label="Rotate clockwise">
          ↻
        </button>
      ) : null}

      {capabilities.search ? (
        <span data-lookglass-group="" data-lookglass-search="">
          <input
            type="search"
            value={query}
            placeholder="Search"
            aria-label="Search document"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              // Enter re-runs the search only when the query changed; otherwise
              // it steps through existing hits, matching browser find.
              if (query !== state.search.query) void controller.search(query);
              else if (event.shiftKey) controller.prevMatch();
              else controller.nextMatch();
            }}
          />
          {state.search.query ? (
            <span data-lookglass-search-status="" aria-live="polite">
              {state.search.running
                ? 'Searching…'
                : state.search.hits.length === 0
                  ? 'No matches'
                  : `${state.search.activeIndex + 1} of ${state.search.hits.length}${state.search.truncated ? '+' : ''}`}
            </span>
          ) : null}
          {state.search.hits.length > 0 ? (
            <>
              <button type="button" onClick={() => controller.prevMatch()} aria-label="Previous match">
                ↑
              </button>
              <button type="button" onClick={() => controller.nextMatch()} aria-label="Next match">
                ↓
              </button>
            </>
          ) : null}
        </span>
      ) : null}

      <span data-lookglass-spacer="" />

      {onPrint && capabilities.print ? (
        <button type="button" onClick={onPrint} aria-label="Print">
          Print
        </button>
      ) : null}
      {onDownload ? (
        <button type="button" onClick={onDownload} aria-label="Download original file">
          Download
        </button>
      ) : null}
    </div>
  );
}
