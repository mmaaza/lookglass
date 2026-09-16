'use client';

import { useSyncExternalStore } from 'react';
import type { DocController, DocState } from '../types.js';

const FALLBACK: DocState = {
  page: 1,
  pageCount: 1,
  sheet: 0,
  viewport: { zoom: 1, rotation: 0, fit: 'width' },
  search: { query: '', hits: [], activeIndex: -1, running: false },
};

/**
 * Subscribe to a document's controller.
 *
 * `useSyncExternalStore` rather than local state on purpose: controller
 * updates arrive from outside React (worker messages, scroll handlers), and
 * this is the only way to read them without tearing during concurrent
 * rendering.
 */
export function useDocState(controller: DocController | undefined): DocState {
  return useSyncExternalStore(
    (listener) => controller?.subscribe(() => listener()) ?? (() => undefined),
    () => controller?.getState() ?? FALLBACK,
    () => controller?.getState() ?? FALLBACK,
  );
}
