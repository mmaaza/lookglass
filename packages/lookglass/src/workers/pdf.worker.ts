/// <reference lib="webworker" />

/**
 * PDF.js worker entry.
 *
 * Two problems are solved here.
 *
 * 1. Loading. Pointing `new Worker(new URL(...))` at
 *    `pdfjs-dist/build/pdf.worker.mjs` needs a bare specifier inside
 *    `new URL()`, which bundlers do not resolve, and the usual workaround — a
 *    CDN `workerSrc` — is unusable offline. This file is bundled with PDF.js
 *    inside it, so it loads like every other lookglass worker, and the worker
 *    always matches the main-thread library version.
 *
 * 2. Starting. PDF.js starts its worker from a static initialiser guarded by
 *    `typeof window === "undefined"`. Next.js compiles client code, worker
 *    chunks included, with `typeof window` replaced by `"object"`, so that
 *    guard becomes `false` and the minifier deletes the start-up block. The
 *    worker then loads, never answers, and the document hangs with no error.
 *    The build removes PDF.js's guarded start-up (see `rollup.config.mjs`) and
 *    this file starts the handler explicitly, exactly once, in every bundler.
 */
import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.min.mjs';

WorkerMessageHandler.initializeFromPort(self);
