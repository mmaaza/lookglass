import { LoadToken } from '../core/cancel.js';
import { ViewerError } from '../core/errors.js';
import { blobSource, formatBytes } from './blob.js';
import type { Source } from './types.js';

/**
 * Origin Private File System cache.
 *
 * This is the load-bearing piece of offline support, and it is deliberately
 * *not* the Cache API. Cache API stores whole opaque responses: it cannot
 * serve a byte range, and reading a 1 GB entry means materialising 1 GB.
 * OPFS gives us a real file handle, so a cached document is still
 * range-sliceable off disk — the same access pattern the network path uses.
 *
 * Net effect: stream a server file to OPFS once, and from then on it is both
 * offline-available and no longer memory-bound.
 */

const CACHE_DIR = 'lookglass-documents';
const META_FILE = 'index.json';

export interface CachedDocument {
  key: string;
  name: string;
  size: number;
  mime?: string;
  /** Epoch ms. */
  cachedAt: number;
  lastOpenedAt: number;
  /** ETag or Last-Modified from the origin, for revalidation when online. */
  version?: string;
}

interface CacheIndex {
  version: 1;
  documents: Record<string, CachedDocument>;
}

export function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined'
  );
}

async function cacheDir(): Promise<FileSystemDirectoryHandle> {
  if (!opfsSupported()) {
    throw new ViewerError('storage-full', 'This browser does not support the Origin Private File System.', {
      retryable: false,
    });
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(CACHE_DIR, { create: true });
}

async function readIndex(dir: FileSystemDirectoryHandle): Promise<CacheIndex> {
  try {
    const handle = await dir.getFileHandle(META_FILE);
    const text = await (await handle.getFile()).text();
    const parsed = JSON.parse(text) as CacheIndex;
    if (parsed.version === 1 && parsed.documents) return parsed;
  } catch {
    /* missing or corrupt index — start fresh rather than failing the open */
  }
  return { version: 1, documents: {} };
}

async function writeIndex(dir: FileSystemDirectoryHandle, index: CacheIndex): Promise<void> {
  const handle = await dir.getFileHandle(META_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(index));
  await writable.close();
}

/** Filesystem-safe name derived from the cache key. */
function fileNameFor(key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `doc-${(hash >>> 0).toString(36)}-${key.length.toString(36)}.bin`;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/** A `Source` backed by an OPFS file. Ranges are served from disk. */
export async function opfsSource(key: string): Promise<Source | undefined> {
  const dir = await cacheDir();
  const index = await readIndex(dir);
  const meta = index.documents[key];
  if (!meta) return undefined;

  let handle: FileSystemFileHandle;
  try {
    handle = await dir.getFileHandle(fileNameFor(key));
  } catch {
    // Index and disk disagree; drop the stale row so we re-fetch cleanly.
    delete index.documents[key];
    await writeIndex(dir, index);
    return undefined;
  }

  const file = await handle.getFile();
  meta.lastOpenedAt = Date.now();
  index.documents[key] = meta;
  void writeIndex(dir, index);

  // `Blob.slice()` on a File handle reads lazily from disk — exactly the
  // property we want, so the blob adapter is reused verbatim here.
  const inner = blobSource(file, meta.name);
  return {
    ...inner,
    id: `opfs:${key}`,
    origin: 'opfs',
    mimeHint: meta.mime ?? inner.mimeHint,
    slice: inner.slice.bind(inner),
    stream: inner.stream.bind(inner),
    bytes: inner.bytes.bind(inner),
    blob: inner.blob.bind(inner),
    descriptor: inner.descriptor.bind(inner),
  };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export interface PersistOptions {
  key?: string;
  version?: string;
  token?: LoadToken;
  onProgress?: (done: number, total: number) => void;
  /** Refuse to cache files over this size. Defaults to 2 GB. */
  maxBytes?: number;
}

/**
 * Stream a source into OPFS and return a source that reads from disk.
 *
 * Streaming matters: the bytes go network -> disk without ever being fully
 * resident in memory, so a 1.5 GB file is cacheable on a device that could
 * never hold it in a single ArrayBuffer.
 */
export async function persistToOpfs(source: Source, opts: PersistOptions = {}): Promise<Source> {
  const key = opts.key ?? source.id;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const total = source.size;

  if (total > maxBytes) {
    throw new ViewerError(
      'too-large',
      `${source.name} is ${formatBytes(total)}, over the ${formatBytes(maxBytes)} offline cache limit.`,
      { detail: { size: total, maxBytes }, retryable: false },
    );
  }

  await assertQuota(total);

  const dir = await cacheDir();
  const handle = await dir.getFileHandle(fileNameFor(key), { create: true });
  const writable = await handle.createWritable();
  const reader = source.stream({ signal: opts.token?.signal }).getReader();
  let written = 0;

  try {
    for (;;) {
      opts.token?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value as unknown as BufferSource);
      written += value.byteLength;
      opts.onProgress?.(written, total);
    }
    await writable.close();
  } catch (err) {
    await writable.abort?.().catch(() => undefined);
    await dir.removeEntry(fileNameFor(key)).catch(() => undefined);
    throw asStorageError(err, source.name);
  } finally {
    reader.releaseLock();
  }

  const index = await readIndex(dir);
  index.documents[key] = {
    key,
    name: source.name,
    size: written,
    mime: source.mimeHint,
    cachedAt: Date.now(),
    lastOpenedAt: Date.now(),
    version: opts.version,
  };
  await writeIndex(dir, index);

  const cached = await opfsSource(key);
  if (!cached) throw new ViewerError('internal', 'Cached document could not be reopened.');
  return cached;
}

/* ------------------------------------------------------------------ *
 * Housekeeping
 * ------------------------------------------------------------------ */

export async function listCached(): Promise<CachedDocument[]> {
  if (!opfsSupported()) return [];
  const dir = await cacheDir();
  const index = await readIndex(dir);
  return Object.values(index.documents).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function evictCached(key: string): Promise<void> {
  const dir = await cacheDir();
  const index = await readIndex(dir);
  delete index.documents[key];
  await writeIndex(dir, index);
  await dir.removeEntry(fileNameFor(key)).catch(() => undefined);
}

export async function clearCache(): Promise<void> {
  if (!opfsSupported()) return;
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(CACHE_DIR, { recursive: true }).catch(() => undefined);
}

/** Evict least-recently-opened documents until the cache fits `targetBytes`. */
export async function trimCache(targetBytes: number): Promise<number> {
  const documents = await listCached();
  let used = documents.reduce((sum, doc) => sum + doc.size, 0);
  let freed = 0;
  for (const doc of [...documents].sort((a, b) => a.lastOpenedAt - b.lastOpenedAt)) {
    if (used <= targetBytes) break;
    await evictCached(doc.key);
    used -= doc.size;
    freed += doc.size;
  }
  return freed;
}

async function assertQuota(needed: number): Promise<void> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') return;
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  if (quota <= 0) return;
  const available = quota - usage;
  // Keep 10% headroom: writes that fill the quota exactly tend to fail late,
  // after most of the file has already been written.
  if (needed > available * 0.9) {
    const freed = await trimCache(Math.max(0, quota * 0.5));
    if (freed === 0 && needed > available) {
      throw new ViewerError(
        'storage-full',
        `Not enough offline storage: need ${formatBytes(needed)}, ${formatBytes(available)} free.`,
        { detail: { needed, available, quota, usage }, retryable: false },
      );
    }
  }
}

function asStorageError(err: unknown, name: string): ViewerError {
  if (err instanceof ViewerError) return err;
  const domError = err as { name?: string };
  if (domError?.name === 'QuotaExceededError') {
    return new ViewerError('storage-full', `Ran out of offline storage while caching ${name}.`, {
      cause: err,
      retryable: false,
    });
  }
  return ViewerError.from(err, 'internal');
}

/**
 * Ask the browser to make storage persistent, so the offline cache is not
 * evicted under disk pressure. Must be called from a user gesture in some
 * browsers; a `false` result is not an error.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
