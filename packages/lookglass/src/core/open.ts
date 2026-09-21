import { detectFormat } from '../detect/index.js';
import { formatBytes, opfsSource, opfsSupported, persistToOpfs, resolveSource } from '../source/index.js';
import type { Source, SourceInput } from '../source/types.js';
import type { DetectedFormat, LoadProgress } from '../types.js';
import { LoadToken } from './cancel.js';
import { ViewerError, isAbort } from './errors.js';
import { sharedMemory, type MemoryManager } from './memory.js';
import { registry } from './registry.js';
import { DEFAULT_RENDERER_OPTIONS, type OpenedDoc, type RendererOptions } from './renderer.js';
import { sharedWorkerPool, type WorkerPool } from './worker-pool.js';

export interface OfflineOptions {
  /**
   * Stream remote documents into OPFS on first open so later opens work with
   * no network. Local `File` inputs are never copied — they already are local.
   */
  cache: boolean;
  /** Stable cache identity. Defaults to the source URL. */
  key?: string;
  /** Version stamp (ETag) used to invalidate a cached copy. */
  version?: string;
  /** Skip caching above this size. Defaults to 2 GB. */
  maxBytes?: number;
  /**
   * When to copy the document into OPFS.
   *
   * `'background'` (default) opens the document straight away over HTTP
   * ranges and caches it in parallel. `'before-open'` copies the whole file
   * first, which guarantees the offline copy exists before anything is shown —
   * but for a 1 GB PDF it also means downloading 1 GB before page 1 appears,
   * which is exactly what range loading exists to avoid.
   */
  mode?: 'background' | 'before-open';
  /** Called once a background copy has been fully written to OPFS. */
  onCached?: () => void;
  /** Called when background caching fails. Viewing is never affected. */
  onCacheError?: (error: ViewerError) => void;
}

export interface OpenDocumentOptions {
  source: SourceInput;
  token?: LoadToken;
  onProgress?: (update: LoadProgress) => void;
  offline?: OfflineOptions;
  options?: Partial<RendererOptions>;
  memory?: MemoryManager;
  workers?: WorkerPool;
  /** Override detection entirely, e.g. to force a text view of anything. */
  forceKind?: DetectedFormat['kind'];
}

export interface OpenDocumentResult {
  doc: OpenedDoc;
  format: DetectedFormat;
  source: Source;
  /** True when the bytes were served from the offline cache. */
  fromCache: boolean;
  dispose(): Promise<void>;
}

let docCounter = 0;

/**
 * Copy a remote document into OPFS without blocking the view.
 *
 * Uses its own source instance so its long streaming read shares no
 * in-flight state with the renderer's range requests. It is tied to the load
 * token: closing the document stops the copy rather than leaving a gigabyte
 * download running for a file the user has moved away from, and a partial
 * copy is discarded, so the next open simply starts again.
 */
function cacheInBackground(input: SourceInput, key: string, offline: OfflineOptions, token: LoadToken): void {
  const background = resolveSource(input);
  token.onDispose(() => background.dispose());

  void (async () => {
    try {
      // Probe first: the size is what the quota and size-limit checks need.
      await background.slice(0, 1, token.signal);
      await persistToOpfs(background, { key, version: offline.version, token, maxBytes: offline.maxBytes });
      if (!token.aborted) offline.onCached?.();
    } catch (err) {
      if (isAbort(err) || token.aborted) return;
      const error = ViewerError.from(err);
      console.warn('[lookglass] background offline caching failed', error);
      offline.onCacheError?.(error);
    }
  })();
}

/**
 * Full open pipeline: resolve bytes -> detect -> load renderer chunk -> open.
 *
 * Every stage checks the token, so an unmount part-way through aborts the
 * fetch, skips the parse and never constructs a worker. Disposal is
 * registered as we go rather than at the end, so a failure mid-pipeline still
 * releases whatever was already acquired.
 */
export async function openDocument(opts: OpenDocumentOptions): Promise<OpenDocumentResult> {
  const token = opts.token ?? new LoadToken();
  const memory = opts.memory ?? sharedMemory();
  const workers = opts.workers ?? sharedWorkerPool();
  const docId = `doc-${++docCounter}`;
  const report = (update: LoadProgress) => opts.onProgress?.(update);

  report({ phase: 'resolving' });
  let source = resolveSource(opts.source);
  let fromCache = false;
  token.onDispose(() => source.dispose());

  try {
    // ---- offline cache -------------------------------------------------
    if (opts.offline?.cache && source.origin === 'http' && opfsSupported()) {
      const key = opts.offline.key ?? source.id;
      const cached = await opfsSource(key).catch(() => undefined);
      token.throwIfAborted();

      if (cached) {
        source = cached;
        fromCache = true;
      } else if ((opts.offline.mode ?? 'background') === 'background') {
        cacheInBackground(opts.source, key, opts.offline, token);
      } else {
        report({ phase: 'persisting', message: 'Saving for offline use' });
        try {
          source = await persistToOpfs(source, {
            key,
            version: opts.offline.version,
            token,
            maxBytes: opts.offline.maxBytes,
            onProgress: (done, total) =>
              report({
                phase: 'persisting',
                bytesDone: done,
                bytesTotal: total,
                ratio: total > 0 ? done / total : undefined,
                message: `Saving for offline use — ${formatBytes(done)}`,
              }),
          });
        } catch (err) {
          if (isAbort(err)) throw err;
          // Caching is an optimisation. A full disk or a quota refusal must
          // not stop the user from viewing the document right now.
          console.warn('[lookglass] offline caching failed; continuing online', err);
        }
      }
    }

    token.throwIfAborted();

    // ---- detect --------------------------------------------------------
    report({ phase: 'detecting' });
    const detected = await detectFormat(source, { signal: token.signal });
    const format: DetectedFormat = opts.forceKind
      ? { ...detected, kind: opts.forceKind, confidence: 1, method: 'fallback' }
      : detected;

    token.throwIfAborted();

    if (format.encrypted) {
      throw new ViewerError(
        'password-required',
        `This ${format.label.toLowerCase()} is password protected. Encrypted Office files cannot be previewed; remove the password in the app that created it, or open it there.`,
        { detail: { name: source.name, kind: format.kind }, retryable: false },
      );
    }

    if (format.kind === 'unknown') {
      throw new ViewerError(
        'unsupported-format',
        `${source.name} is not a file type lookglass can display.`,
        { detail: { name: source.name, size: source.size }, retryable: false },
      );
    }

    // Legacy binary Office formats are recognised only so the message can
    // say what the file is and what to do about it.
    const legacy = LEGACY_FORMATS[format.kind];
    if (legacy && !registry.supports(format.kind)) {
      throw new ViewerError('unsupported-format', legacy, {
        detail: { name: source.name, kind: format.kind },
        retryable: false,
      });
    }

    // ---- renderer ------------------------------------------------------
    report({ phase: 'parsing', message: `Loading the ${format.label.toLowerCase()} viewer` });
    const factory = await registry.resolve(format.kind);
    token.throwIfAborted();

    const rendererOptions: RendererOptions = { ...DEFAULT_RENDERER_OPTIONS, ...opts.options };
    const scoped = memory.scope(docId);
    token.onDispose(() => scoped.dispose());

    const doc = await factory.open({
      source,
      format,
      token,
      memory: scoped,
      workers,
      docId,
      onProgress: report,
      options: rendererOptions,
    });

    token.onDispose(() => doc.dispose());
    token.throwIfAborted();
    report({ phase: 'ready' });

    return {
      doc,
      format,
      source,
      fromCache,
      dispose: () => token.dispose(),
    };
  } catch (err) {
    await token.dispose();
    if (isAbort(err)) throw err;
    throw ViewerError.from(err);
  }
}

const LEGACY_FORMATS: Partial<Record<DetectedFormat['kind'], string>> = {
  doc: 'Word 97-2003 documents (.doc) cannot be previewed. Save the file as .docx in Word and open it again.',
  ppt: 'PowerPoint 97-2003 presentations (.ppt) cannot be previewed. Save the file as .pptx in PowerPoint and open it again.',
};
