'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { BaseController } from '../../core/controller.js';
import type { SurfaceProps } from '../../core/renderer.js';
import type { DocState } from '../../types.js';
import { columnLetters, parseHitId, type CellDetail, type CellRange, type GridSheetInfo } from '../../workers/grid-types.js';
import type { GridStore } from './grid-store.js';

export interface GridSurfaceConfig {
  store: GridStore;
  controller: BaseController;
  label: string;
}

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 26;
const FONT_SIZE = 13;

/**
 * Two-axis virtualised grid, shared by CSV and workbooks.
 *
 * Layout: the column header strip and the row-number strip are `sticky`
 * elements inside the same scroll container as the cells, so the three move
 * together natively — no JavaScript scroll syncing, which always lags a
 * frame and visibly shears on fast scrolls.
 */
export function createGridSurface(config: GridSurfaceConfig) {
  const { store, controller, label } = config;

  return function GridSurface({ className }: SurfaceProps) {
    const state = useControllerState(controller);
    const sheetIndex = state.sheet;
    const [info, setInfo] = useState<GridSheetInfo | undefined>();
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
      let live = true;
      setInfo(undefined);
      setError(undefined);
      store.sheet(sheetIndex).then(
        (loaded) => {
          if (!live) return;
          setInfo(loaded);
          controller.setPageCount(Math.max(1, loaded.rowCount));
        },
        (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
      );
      return () => {
        live = false;
      };
    }, [sheetIndex]);

    if (error) {
      return (
        <div className={className} data-lookglass-surface="grid" data-lookglass-grid-message="" role="alert">
          {error}
        </div>
      );
    }
    if (!info) {
      return (
        <div className={className} data-lookglass-surface="grid" data-lookglass-grid-message="" role="status">
          Loading sheet…
        </div>
      );
    }
    if (info.rowCount === 0 || info.columnCount === 0) {
      return (
        <div className={className} data-lookglass-surface="grid" data-lookglass-grid-message="">
          This sheet is empty.
        </div>
      );
    }
    return <Grid key={info.index} className={className} info={info} state={state} store={store} controller={controller} label={label} />;
  };
}

interface GridProps {
  className?: string;
  info: GridSheetInfo;
  state: DocState;
  store: GridStore;
  controller: BaseController;
  label: string;
}

function Grid({ className, info, state, store, controller, label }: GridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);

  const zoom = state.viewport.zoom;
  const rowHeight = Math.round(ROW_HEIGHT * zoom);
  const headerHeight = Math.round(HEADER_HEIGHT * zoom);
  const lastRowNumber = info.firstRowNumber + info.rowCount - 1;
  const rowHeaderWidth = Math.round((String(lastRowNumber).length * 8 + 20) * zoom);
  const widths = useMemo(
    () => Array.from({ length: info.columnCount }, (_, c) => Math.round((info.columnWidths[c] ?? 80) * zoom)),
    [info, zoom],
  );

  const rows = useVirtualizer({
    count: info.rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    paddingStart: headerHeight,
    // The sticky header covers the top of the viewport. Without this, a row
    // scrolled to "start" lands underneath it: the user jumps to a search hit
    // and cannot see it.
    scrollPaddingStart: headerHeight,
  });
  const columns = useVirtualizer({
    horizontal: true,
    count: info.columnCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => widths[index] ?? 80,
    overscan: 3,
    paddingStart: rowHeaderWidth,
    // Same for the sticky row-number column on the left.
    scrollPaddingStart: rowHeaderWidth,
  });

  useEffect(() => {
    rows.measure();
    columns.measure();
  }, [rowHeight, widths, rows, columns]);

  const rowItems = rows.getVirtualItems();
  const columnItems = columns.getVirtualItems();
  const r0 = rowItems[0]?.index ?? 0;
  const r1 = (rowItems[rowItems.length - 1]?.index ?? 0) + 1;
  const c0 = columnItems[0]?.index ?? 0;
  const c1 = (columnItems[columnItems.length - 1]?.index ?? 0) + 1;
  store.ensure(info.index, info, r0, r1, c0, c1);

  // ---- selection and formula bar ------------------------------------------
  const [selection, setSelection] = useState<{ r: number; c: number } | undefined>();
  const [detail, setDetail] = useState<CellDetail | undefined>();

  useEffect(() => {
    if (!selection) {
      setDetail(undefined);
      return;
    }
    let live = true;
    store.detail(info.index, selection.r, selection.c).then(
      (result) => live && setDetail(result),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [selection, info.index, store]);

  const reveal = useCallback(
    (r: number, c: number, align: 'auto' | 'center' = 'auto') => {
      rows.scrollToIndex(r, { align });
      columns.scrollToIndex(c, { align: 'auto' });
    },
    [rows, columns],
  );

  // ---- navigation -----------------------------------------------------------
  useEffect(() => {
    if (controller.pageFromScroll()) return;
    rows.scrollToIndex(state.page - 1, { align: 'start' });
  }, [state.page, rows]);

  const activeHit = state.search.hits[state.search.activeIndex];
  const active = activeHit ? parseHitId(activeHit.id) : undefined;
  useEffect(() => {
    if (!active || active.sheet !== info.index) return;
    setSelection({ r: active.r, c: active.c });
    reveal(active.r, active.c, 'center');
    // Only when the active hit changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHit?.id]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const item = rows.getVirtualItemForOffset(element.scrollTop + headerHeight + rowHeight / 2);
    if (item) controller.syncPage(item.index + 1);
  }, [rows, headerHeight, rowHeight]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const moves: Record<string, [number, number]> = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
        Tab: [0, event.shiftKey ? -1 : 1],
        Enter: [event.shiftKey ? -1 : 1, 0],
      };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      // Arrow keys belong to the grid, not the page.
      event.stopPropagation();
      setSelection((current) => {
        const base = current ?? { r: 0, c: 0 };
        const next = {
          r: Math.max(0, Math.min(info.rowCount - 1, base.r + move[0])),
          c: Math.max(0, Math.min(info.columnCount - 1, base.c + move[1])),
        };
        reveal(next.r, next.c);
        return next;
      });
    },
    [info, reveal],
  );

  // ---- merges -------------------------------------------------------------------
  const rowMeasures = rows.measurementsCache;
  const columnMeasures = columns.measurementsCache;
  const visibleMerges = info.merges.filter(
    (merge) => merge.e.r >= r0 && merge.s.r < r1 && merge.e.c >= c0 && merge.s.c < c1,
  );
  const covered = new Set<string>();
  for (const merge of visibleMerges) {
    // The anchor holds the merged value and can sit outside the visible
    // window (a title merged across rows 1-3, scrolled to row 2).
    store.ensure(info.index, info, merge.s.r, merge.s.r + 1, merge.s.c, merge.s.c + 1);
    for (let r = Math.max(merge.s.r, r0); r <= Math.min(merge.e.r, r1 - 1); r++) {
      for (let c = Math.max(merge.s.c, c0); c <= Math.min(merge.e.c, c1 - 1); c++) covered.add(`${r}:${c}`);
    }
  }

  const query = state.search.query.toLowerCase();
  const totalWidth = columns.getTotalSize();
  const totalHeight = rows.getTotalSize();

  const renderCell = (r: number, c: number, left: number, top: number, width: number, height: number, key: string) => {
    const cell = store.cell(info.index, r, c);
    const isSelected = selection?.r === r && selection?.c === c;
    const isActive = active?.sheet === info.index && active.r === r && active.c === c;
    const isMatch = query !== '' && cell !== undefined && cell.text.toLowerCase().includes(query);
    return (
      <div
        key={key}
        data-lookglass-cell=""
        data-type={cell?.type}
        data-lookglass-selected={isSelected || undefined}
        data-lookglass-match={isMatch || undefined}
        data-lookglass-active={isActive || undefined}
        data-row={r}
        data-col={c}
        role="gridcell"
        aria-selected={isSelected}
        onMouseDown={() => setSelection({ r, c })}
        style={{ position: 'absolute', left, top, width, height }}
      >
        {cell === undefined ? <span data-lookglass-skeleton="" aria-hidden="true" /> : cell.text}
      </div>
    );
  };

  return (
    <div className={className} data-lookglass-surface="grid" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div data-lookglass-formula-bar="">
        <span data-lookglass-cell-address="">{detail?.address ?? ''}</span>
        <span data-lookglass-cell-content="" title={detail?.formula ?? detail?.display}>
          {detail?.formula ?? detail?.display ?? ''}
        </span>
      </div>
      {info.truncated ? (
        <div data-lookglass-notice="" role="status">
          Showing the first {info.truncated.shownRows.toLocaleString()} rows
          {info.truncated.totalRows > info.truncated.shownRows
            ? ` of ${info.truncated.totalRows.toLocaleString()}`
            : ''}
          . Export this sheet as CSV to view every row.
        </div>
      ) : null}
      <div
        ref={scrollRef}
        role="grid"
        aria-label={`${label}, ${info.name}`}
        aria-rowcount={info.rowCount}
        aria-colcount={info.columnCount}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', position: 'relative', fontSize: FONT_SIZE * zoom }}
      >
        <div style={{ width: totalWidth, height: totalHeight, position: 'relative' }}>
          {/* Column headers: sticky to the top, in flow so they take no layout from the cells. */}
          <div data-lookglass-col-headers="" style={{ position: 'sticky', top: 0, height: headerHeight, width: totalWidth, zIndex: 3 }}>
            <div data-lookglass-corner="" style={{ position: 'sticky', left: 0, width: rowHeaderWidth, height: headerHeight, zIndex: 4 }} />
            {columnItems.map((column) => (
              <div
                key={column.key}
                data-lookglass-col-header=""
                data-lookglass-selected={selection?.c === column.index || undefined}
                role="columnheader"
                title={info.columnTitles?.[column.index]}
                style={{ position: 'absolute', top: 0, left: column.start, width: column.size, height: headerHeight }}
              >
                {info.columnTitles?.[column.index] || columnLetters(column.index)}
              </div>
            ))}
          </div>

          {/* Row numbers: sticky to the left, starting below the header. */}
          <div
            data-lookglass-row-headers=""
            style={{ position: 'sticky', left: 0, width: rowHeaderWidth, height: totalHeight - headerHeight, zIndex: 2 }}
          >
            {rowItems.map((row) => (
              <div
                key={row.key}
                data-lookglass-row-header=""
                data-lookglass-selected={selection?.r === row.index || undefined}
                role="rowheader"
                style={{ position: 'absolute', left: 0, top: row.start - headerHeight, width: rowHeaderWidth, height: row.size }}
              >
                {info.firstRowNumber + row.index}
              </div>
            ))}
          </div>

          {rowItems.flatMap((row) =>
            columnItems.map((column) =>
              covered.has(`${row.index}:${column.index}`) || column.size === 0
                ? null
                : renderCell(row.index, column.index, column.start, row.start, column.size, row.size, `${row.key}:${column.key}`),
            ),
          )}

          {visibleMerges.map((merge) => renderMerge(merge))}
        </div>
      </div>
    </div>
  );

  function renderMerge(merge: CellRange) {
    const top = rowMeasures[merge.s.r]?.start;
    const left = columnMeasures[merge.s.c]?.start;
    const bottom = rowMeasures[Math.min(merge.e.r, info.rowCount - 1)]?.end;
    const right = columnMeasures[Math.min(merge.e.c, info.columnCount - 1)]?.end;
    if (top === undefined || left === undefined || bottom === undefined || right === undefined) return null;
    return renderCell(merge.s.r, merge.s.c, left, top, right - left, bottom - top, `merge:${merge.s.r}:${merge.s.c}`);
  }
}

function useControllerState(controller: BaseController): DocState {
  return useSyncExternalStore(
    (listener) => controller.subscribe(() => listener()),
    () => controller.getState(),
    () => controller.getState(),
  );
}
