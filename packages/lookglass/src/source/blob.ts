import { ViewerError } from '../core/errors.js';
import { DEFAULT_MAX_WHOLE_FILE, type BytesOptions, type Source, type StreamOptions } from './types.js';

let counter = 0;

/**
 * Local `File`/`Blob` source. Range access is free here — `Blob.slice()` is a
 * view, not a copy, and the browser only reads from disk on `arrayBuffer()`.
 */
export function blobSource(blob: Blob, name?: string): Source {
  const id = `blob:${++counter}:${blob.size}`;
  const label = name ?? (blob instanceof File ? blob.name : 'untitled');
  const mime = blob.type || undefined;

  return {
    id,
    name: label,
    size: blob.size,
    mimeHint: mime,
    supportsRange: true,
    origin: 'blob',

    async slice(start, end, signal) {
      signal?.throwIfAborted();
      const from = clamp(start, 0, blob.size);
      const to = clamp(end, from, blob.size);
      if (to === from) return new Uint8Array(0);
      const buffer = await blob.slice(from, to).arrayBuffer();
      signal?.throwIfAborted();
      return new Uint8Array(buffer);
    },

    stream(opts: StreamOptions = {}) {
      const from = clamp(opts.start ?? 0, 0, blob.size);
      const to = clamp(opts.end ?? blob.size, from, blob.size);
      const sliced = from === 0 && to === blob.size ? blob : blob.slice(from, to);
      return sliced.stream() as ReadableStream<Uint8Array>;
    },

    async bytes(opts: BytesOptions = {}) {
      const max = opts.maxBytes ?? DEFAULT_MAX_WHOLE_FILE;
      if (blob.size > max) throw tooLarge(label, blob.size, max);
      opts.signal?.throwIfAborted();
      const buffer = await blob.arrayBuffer();
      opts.onProgress?.(blob.size, blob.size);
      return new Uint8Array(buffer);
    },

    async blob() {
      return blob;
    },

    async descriptor() {
      return { kind: 'blob' as const, blob, name: label, mime: mime };
    },

    dispose() {
      /* The consumer owns the File; nothing to release. */
    },
  };
}

export function tooLarge(name: string, size: number, max: number): ViewerError {
  return new ViewerError(
    'too-large',
    `${name} is ${formatBytes(size)}, over the ${formatBytes(max)} limit for this operation.`,
    { detail: { size, max }, retryable: false },
  );
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
