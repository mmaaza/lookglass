import { ViewerError } from '../core/errors.js';
import { blobSource, formatBytes } from './blob.js';
import { httpSource } from './http.js';
import {
  isSource,
  type RemoteSourceInput,
  type Source,
  type SourceDescriptor,
  type SourceInput,
} from './types.js';

export { blobSource, formatBytes, tooLarge, clamp } from './blob.js';
export { httpSource } from './http.js';
export {
  opfsSource,
  opfsSupported,
  persistToOpfs,
  listCached,
  evictCached,
  clearCache,
  trimCache,
  requestPersistentStorage,
  type CachedDocument,
  type PersistOptions,
} from './opfs.js';
export * from './types.js';

/** Wrap an in-memory buffer. Only appropriate for genuinely small inputs. */
export function memorySource(data: Uint8Array | ArrayBuffer, name = 'buffer', mime?: string): Source {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const blob = new Blob([bytes.slice().buffer], mime ? { type: mime } : undefined);
  const inner = blobSource(blob, name);
  return { ...inner, id: `memory:${name}:${bytes.byteLength}`, origin: 'memory' };
}

/**
 * Normalise every accepted input shape into a `Source`.
 *
 * Both of the app's paths land here: a `File` from an `<input type="file">`
 * becomes a `blobSource` (ranges are free), and a URL served by the app's own
 * backend becomes an `httpSource` (ranges come from the server).
 */
export function resolveSource(input: SourceInput): Source {
  if (isSource(input)) return input;

  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return blobSource(input);
  }

  if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
    return memorySource(input);
  }

  if (typeof input === 'string' || input instanceof URL) {
    return httpSource({ url: input });
  }

  if (typeof input === 'object' && input !== null && 'url' in input) {
    return httpSource(input as RemoteSourceInput);
  }

  throw new ViewerError(
    'internal',
    'Unsupported source. Pass a File, Blob, ArrayBuffer, URL string, { url } object, or a Source.',
    { detail: { received: typeof input }, retryable: false },
  );
}

/**
 * Rebuild a source inside a worker from its descriptor.
 *
 * Blob descriptors clone by reference across the thread boundary, so the
 * worker slices the very same bytes the main thread had — no copy, no
 * duplicated memory, regardless of how large the file is.
 */
export function sourceFromDescriptor(descriptor: SourceDescriptor): Source {
  if (descriptor.kind === 'blob') {
    return blobSource(descriptor.blob, descriptor.name);
  }
  return httpSource({
    url: descriptor.url,
    name: descriptor.name,
    size: descriptor.size,
    mime: descriptor.mime,
    headers: descriptor.headers,
  });
}
