'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { BaseController } from '../../core/controller.js';
import type { SurfaceProps } from '../../core/renderer.js';
import type { DocState } from '../../types.js';
import { NodeKind, type TreeRow } from '../../workers/tree-model.js';
import { TREE_BLOCK_ROWS, type TreeStore } from './tree-store.js';

export interface TreeSurfaceConfig {
  store: TreeStore;
  controller: BaseController;
  /** Accessible description, e.g. "JSON document". */
  label: string;
}

const ROW_HEIGHT = 22;
const INDENT = 14;
const OVERSCAN = 20;

/**
 * Virtualised tree surface, shared by JSON and XML.
 *
 * The two formats differ only in how their worker fills in `TreeRow`, so
 * everything below — virtualisation, expansion, keyboard nav, copy-path — is
 * written once. Adding YAML or TOML later means writing a parser, not a UI.
 */
export function createTreeSurface(config: TreeSurfaceConfig) {
  const { store, controller, label } = config;

  return function TreeSurface({ className }: SurfaceProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const state = useControllerState(controller);
    useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);

    const count = store.visibleCount;

    const virtualizer = useVirtualizer({
      count,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ROW_HEIGHT * state.viewport.zoom,
      overscan: OVERSCAN,
    });

    const items = virtualizer.getVirtualItems();
    const first = items[0]?.index ?? 0;
    const last = items[items.length - 1]?.index ?? 0;
    store.ensureRange(first - TREE_BLOCK_ROWS, last + TREE_BLOCK_ROWS);

    // The controller's "page" is the visible row index, which is how search
    // hits and the toolbar drive scrolling for every format.
    const target = state.page - 1;
    const lastScrolled = useRef(-1);
    useEffect(() => {
      if (target === lastScrolled.current) return;
      lastScrolled.current = target;
      if (target >= 0 && target < count) virtualizer.scrollToIndex(target, { align: 'center' });
    }, [target, count, virtualizer]);

    const toggle = useCallback((row: TreeRow) => {
      if (row.childCount === 0) return;
      void store.toggle(row.index);
    }, []);

    const onKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>, row: TreeRow) => {
        switch (event.key) {
          case 'ArrowRight':
            if (!row.expanded && row.childCount > 0) {
              event.preventDefault();
              void store.toggle(row.index);
            }
            break;
          case 'ArrowLeft':
            if (row.expanded) {
              event.preventDefault();
              void store.toggle(row.index);
            }
            break;
          case 'Enter':
          case ' ':
            event.preventDefault();
            toggle(row);
            break;
          case 'c':
            if (event.ctrlKey || event.metaKey) {
              // Copy the path rather than the row text: the path is what is
              // actually useful from a tree, and it needs a worker round trip.
              event.preventDefault();
              void store.path(row.index).then((path) => navigator.clipboard?.writeText(path));
            }
            break;
          default:
            break;
        }
      },
      [toggle],
    );

    return (
      <div
        ref={scrollRef}
        className={className}
        data-lookglass-surface="tree"
        role="tree"
        aria-label={`${label}, ${count.toLocaleString()} visible rows`}
        tabIndex={0}
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
            const row = store.getRow(item.index);
            return (
              <div
                key={item.key}
                data-lookglass-tree-row=""
                data-lookglass-active={state.page - 1 === item.index || undefined}
                role="treeitem"
                aria-level={(row?.depth ?? 0) + 1}
                aria-expanded={row && row.childCount > 0 ? row.expanded : undefined}
                tabIndex={-1}
                onKeyDown={row ? (event) => onKeyDown(event, row) : undefined}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                  paddingLeft: `${(row?.depth ?? 0) * INDENT + 6}px`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                {row === undefined ? (
                  <span data-lookglass-skeleton="" aria-hidden="true" />
                ) : (
                  <>
                    <button
                      type="button"
                      data-lookglass-twisty=""
                      data-lookglass-open={row.expanded || undefined}
                      onClick={() => toggle(row)}
                      tabIndex={-1}
                      aria-hidden={row.childCount === 0}
                      style={{ visibility: row.childCount > 0 ? 'visible' : 'hidden' }}
                    >
                      ▸
                    </button>
                    {row.key !== '' ? (
                      <span data-lookglass-tree-key="" data-lookglass-index={isIndexKey(row) || undefined}>
                        {row.key}
                      </span>
                    ) : null}
                    {row.attributes?.length ? (
                      <span data-lookglass-tree-attrs="">
                        {row.attributes.map(([name, value]) => (
                          <span key={name} data-lookglass-tree-attr="">
                            <span data-lookglass-attr-name="">{name}</span>
                            <span data-lookglass-attr-value="">"{value}"</span>
                          </span>
                        ))}
                      </span>
                    ) : null}
                    <span data-lookglass-tree-value="" data-lookglass-kind={kindName(row.kind)}>
                      {row.preview}
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };
}

/** Array indices are styled differently from object keys. */
function isIndexKey(row: TreeRow): boolean {
  return /^\d+$/.test(row.key) && row.kind !== NodeKind.Element;
}

function kindName(kind: NodeKind): string {
  switch (kind) {
    case NodeKind.Object:
      return 'object';
    case NodeKind.Array:
      return 'array';
    case NodeKind.String:
      return 'string';
    case NodeKind.Number:
      return 'number';
    case NodeKind.Boolean:
      return 'boolean';
    case NodeKind.Null:
      return 'null';
    case NodeKind.Element:
      return 'element';
    case NodeKind.Text:
      return 'text';
    case NodeKind.Comment:
      return 'comment';
    case NodeKind.CData:
      return 'cdata';
    case NodeKind.Instruction:
      return 'instruction';
    default:
      return 'other';
  }
}

function useControllerState(controller: BaseController): DocState {
  return useSyncExternalStore(
    (listener) => controller.subscribe(() => listener()),
    () => controller.getState(),
    () => controller.getState(),
  );
}
