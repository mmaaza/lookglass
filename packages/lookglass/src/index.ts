/**
 * Server-safe entry point.
 *
 * Nothing here touches the DOM, `window`, or a worker, so this module can be
 * imported from a React Server Component, a route handler or a Node script —
 * typically to detect a format server-side and decide what to send.
 * The viewer UI lives in `lookglass/react`; the hooks in `lookglass/headless`.
 */

export * from './types.js';

export { detectFormat, extensionOf, labelFor, type DetectOptions } from './detect/index.js';
export { EXTENSION_MAP, MIME_MAP } from './detect/signatures.js';

export {
  resolveSource,
  blobSource,
  httpSource,
  memorySource,
  sourceFromDescriptor,
  formatBytes,
  type Source,
  type SourceInput,
  type SourceDescriptor,
  type RemoteSourceInput,
} from './source/index.js';

export {
  opfsSupported,
  persistToOpfs,
  opfsSource,
  listCached,
  evictCached,
  clearCache,
  trimCache,
  requestPersistentStorage,
  type CachedDocument,
} from './source/opfs.js';

export { ViewerError, isAbort } from './core/errors.js';
export { registry, registerRenderer, type RendererRegistration } from './core/registry.js';
export { DEFAULT_RENDERER_OPTIONS, type RendererFactory, type RendererOptions, type OpenedDoc } from './core/renderer.js';
export { setWorkerResolver, type WorkerResolver, type WorkerName } from './core/worker-pool.js';
export { configureMemory, sharedMemory, type MemoryStats } from './core/memory.js';
export { LoadToken } from './core/cancel.js';
