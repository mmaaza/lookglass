/**
 * The byte-access contract every renderer reads through.
 *
 * The invariant that makes large files work: nothing in lookglass calls
 * `file.arrayBuffer()` on an unbounded source. Renderers ask for the ranges
 * they need, and `bytes()` — the whole-file escape hatch — requires an
 * explicit `maxBytes` budget so an accidental 2 GB allocation is impossible.
 */
export interface Source {
  /** Stable identity, used for cache keys and OPFS filenames. */
  readonly id: string;
  readonly name: string;
  /** Total bytes, or -1 when the transport would not tell us. */
  readonly size: number;
  /** Declared content type from the transport or the File object. Untrusted. */
  readonly mimeHint?: string;
  /** True when `slice()` is cheap and does not buffer the whole file. */
  readonly supportsRange: boolean;
  readonly origin: SourceOrigin;

  /** Half-open byte range `[start, end)`. Clamped to the file. */
  slice(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  stream(opts?: StreamOptions): ReadableStream<Uint8Array>;
  /** Whole file. Throws `too-large` when it exceeds `maxBytes`. */
  bytes(opts?: BytesOptions): Promise<Uint8Array>;
  blob(): Promise<Blob>;
  /**
   * A structured-cloneable handle this source can be rebuilt from inside a
   * worker. Blobs clone by reference, so handing a 1 GB local file to a
   * worker costs nothing — the worker slices the same underlying data.
   */
  descriptor(): Promise<SourceDescriptor>;
  dispose(): void | Promise<void>;
}

/** Worker-transferable description of a source. */
export type SourceDescriptor =
  | { kind: 'blob'; blob: Blob; name: string; mime?: string }
  | { kind: 'url'; url: string; name: string; size: number; mime?: string; headers?: Record<string, string> };

export type SourceOrigin = 'blob' | 'http' | 'opfs' | 'memory';

export interface StreamOptions {
  start?: number;
  end?: number;
  signal?: AbortSignal;
}

export interface BytesOptions {
  /** Hard ceiling. Defaults to 64 MB — deliberately small. */
  maxBytes?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Anything the consumer is allowed to hand `<FileViewer source={...}>`. */
export type SourceInput =
  | Source
  | File
  | Blob
  | ArrayBuffer
  | Uint8Array
  | string
  | URL
  | RemoteSourceInput;

export interface RemoteSourceInput {
  url: string | URL;
  name?: string;
  headers?: Record<string, string>;
  /** Passed through to `fetch`; use for cookies/credentials. */
  credentials?: RequestCredentials;
  /** Skip the capability probe and assert what the server does. */
  size?: number;
  mime?: string;
}

export const DEFAULT_MAX_WHOLE_FILE = 64 * 1024 * 1024;

export function isSource(value: unknown): value is Source {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Source).slice === 'function' &&
    typeof (value as Source).stream === 'function' &&
    'supportsRange' in (value as Source)
  );
}
