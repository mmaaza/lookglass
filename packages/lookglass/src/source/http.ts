import { ViewerError } from '../core/errors.js';
import { clamp, formatBytes, tooLarge } from './blob.js';
import {
  DEFAULT_MAX_WHOLE_FILE,
  type BytesOptions,
  type RemoteSourceInput,
  type Source,
  type StreamOptions,
} from './types.js';

interface Capability {
  size: number;
  supportsRange: boolean;
  mime?: string;
  etag?: string;
}

/**
 * Remote source with HTTP range support.
 *
 * This is what makes "page 400 of a 1 GB PDF" cost a few kB instead of a
 * gigabyte. Servers lie about range support in both directions, so we probe
 * once and verify every 206 response rather than trusting `Accept-Ranges`.
 *
 * When the server genuinely cannot do ranges we fall back to downloading the
 * file once into memory — but only up to `maxWholeFile`, and we report
 * `supportsRange: false` so renderers can pick a cheaper strategy.
 */
export function httpSource(input: RemoteSourceInput, opts: { maxWholeFile?: number } = {}): Source {
  const url = String(input.url);
  const name = input.name ?? filenameFromUrl(url);
  const maxWholeFile = opts.maxWholeFile ?? 512 * 1024 * 1024;
  const headers = input.headers ?? {};
  const credentials = input.credentials ?? 'same-origin';

  let capability: Promise<Capability> | undefined;
  let whole: Promise<Uint8Array> | undefined;
  let known: Capability | undefined;
  const inflight = new Set<AbortController>();

  const probe = (): Promise<Capability> => {
    capability ??= probeCapability(url, headers, credentials, input).then((cap) => {
      known = cap;
      return cap;
    });
    return capability;
  };

  const request = async (init: RequestInit, signal?: AbortSignal): Promise<Response> => {
    const controller = new AbortController();
    inflight.add(controller);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    try {
      return await fetch(url, {
        ...init,
        credentials,
        signal: controller.signal,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (err) {
      throw wrapNetwork(err, url);
    } finally {
      inflight.delete(controller);
    }
  };

  const downloadWhole = async (
    signal?: AbortSignal,
    onProgress?: BytesOptions['onProgress'],
  ): Promise<Uint8Array> => {
    const cap = await probe();
    if (cap.size > maxWholeFile) throw tooLarge(name, cap.size, maxWholeFile);
    const response = await request({ method: 'GET' }, signal);
    if (!response.ok) throw httpError(response, url);
    return readAll(response, cap.size, onProgress);
  };

  return {
    id: `http:${url}`,
    name,
    get size() {
      return input.size ?? known?.size ?? -1;
    },
    get mimeHint() {
      return input.mime ?? known?.mime;
    },
    get supportsRange() {
      // Optimistic until probed. Callers that care should await `slice()` or
      // use `probeSource()` before branching on this.
      return known?.supportsRange ?? true;
    },
    origin: 'http',

    async slice(start, end, signal) {
      signal?.throwIfAborted();
      const cap = await probe();
      const from = clamp(start, 0, cap.size);
      const to = clamp(end, from, cap.size);
      if (to === from) return new Uint8Array(0);

      if (!cap.supportsRange) {
        whole ??= downloadWhole(signal);
        return (await whole).subarray(from, to);
      }

      const response = await request(
        { method: 'GET', headers: { Range: `bytes=${from}-${to - 1}` } },
        signal,
      );

      if (response.status === 416) {
        throw new ViewerError('network', `Server rejected byte range ${from}-${to - 1} of ${name}.`, {
          detail: { from, to, size: cap.size },
        });
      }
      if (!response.ok) throw httpError(response, url);

      if (response.status !== 206) {
        // Server ignored Range and sent the whole body. Downgrade once, cache,
        // and slice locally rather than repeating full downloads per range.
        cap.supportsRange = false;
        whole ??= readAll(response, cap.size);
        return (await whole).subarray(from, to);
      }

      const buffer = new Uint8Array(await response.arrayBuffer());
      const expected = to - from;
      // Some proxies truncate ranges. Use what arrived, but never over-read.
      return buffer.byteLength > expected ? buffer.subarray(0, expected) : buffer;
    },

    stream(streamOpts: StreamOptions = {}) {
      const { start = 0, end, signal } = streamOpts;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

      return new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const wantsRange = start > 0 || end !== undefined;
          const rangeHeaders = wantsRange
            ? { Range: `bytes=${start}-${end !== undefined ? end - 1 : ''}` }
            : undefined;
          const response = await request({ method: 'GET', headers: rangeHeaders }, signal);
          if (!response.ok) {
            controller.error(httpError(response, url));
            return;
          }
          if (!response.body) {
            controller.error(new ViewerError('network', `${name} returned an empty response body.`));
            return;
          }
          reader = response.body.getReader();
        },
        pull: async (controller) => {
          if (!reader) return;
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel: (reason) => {
          void reader?.cancel(reason);
        },
      });
    },

    async bytes(bytesOpts: BytesOptions = {}) {
      const max = bytesOpts.maxBytes ?? DEFAULT_MAX_WHOLE_FILE;
      const cap = await probe();
      if (cap.size >= 0 && cap.size > max) throw tooLarge(name, cap.size, max);
      whole ??= downloadWhole(bytesOpts.signal, bytesOpts.onProgress);
      const buffer = await whole;
      if (buffer.byteLength > max) throw tooLarge(name, buffer.byteLength, max);
      return buffer;
    },

    async blob() {
      const cap = await probe();
      const buffer = await this.bytes({ maxBytes: Math.max(cap.size, DEFAULT_MAX_WHOLE_FILE) });
      const part = buffer.slice().buffer;
      return new Blob([part], cap.mime ? { type: cap.mime } : undefined);
    },

    async descriptor() {
      const cap = await probe();
      return {
        kind: 'url' as const,
        url,
        name,
        size: cap.size,
        mime: cap.mime,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      };
    },

    dispose() {
      for (const controller of inflight) controller.abort();
      inflight.clear();
      whole = undefined;
    },
  };
}

async function probeCapability(
  url: string,
  headers: Record<string, string>,
  credentials: RequestCredentials,
  input: RemoteSourceInput,
): Promise<Capability> {
  if (input.size !== undefined) {
    return { size: input.size, supportsRange: true, mime: input.mime };
  }

  // HEAD is cheapest when it works, but plenty of servers and CDNs disable it,
  // so a failure here is not conclusive.
  try {
    const head = await fetch(url, { method: 'HEAD', headers, credentials });
    if (head.ok) {
      const length = Number(head.headers.get('content-length'));
      const acceptsRanges = (head.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes');
      if (Number.isFinite(length) && length > 0) {
        return {
          size: length,
          supportsRange: acceptsRanges,
          mime: head.headers.get('content-type') ?? undefined,
          etag: head.headers.get('etag') ?? undefined,
        };
      }
    }
  } catch {
    /* fall through to the range probe */
  }

  // A one-byte ranged GET is the reliable probe: a 206 proves range support
  // and its Content-Range reports the total, in one round trip.
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0' },
      credentials,
    });

    if (response.status === 206) {
      const total = parseContentRangeTotal(response.headers.get('content-range'));
      void response.body?.cancel();
      if (total !== undefined) {
        return {
          size: total,
          supportsRange: true,
          mime: response.headers.get('content-type') ?? undefined,
          etag: response.headers.get('etag') ?? undefined,
        };
      }
    }

    if (response.ok) {
      const length = Number(response.headers.get('content-length'));
      void response.body?.cancel();
      return {
        size: Number.isFinite(length) ? length : -1,
        supportsRange: false,
        mime: response.headers.get('content-type') ?? undefined,
      };
    }

    throw httpError(response, url);
  } catch (err) {
    throw wrapNetwork(err, url);
  }
}

function parseContentRangeTotal(header: string | null): number | undefined {
  if (!header) return undefined;
  const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(header);
  if (!match) return undefined;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : undefined;
}

async function readAll(
  response: Response,
  expected: number,
  onProgress?: BytesOptions['onProgress'],
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    onProgress?.(total, expected);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function httpError(response: Response, url: string): ViewerError {
  return new ViewerError('network', `Request for ${url} failed with ${response.status} ${response.statusText}.`, {
    detail: { status: response.status, url },
    retryable: response.status >= 500 || response.status === 429,
  });
}

function wrapNetwork(err: unknown, url: string): ViewerError {
  if (err instanceof ViewerError) return err;
  if (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError') {
    return new ViewerError('aborted', 'Loading was cancelled.', { cause: err });
  }
  return new ViewerError('network', `Could not reach ${url}. Check the connection or CORS headers.`, {
    cause: err,
    retryable: true,
  });
}

function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url, 'http://localhost').pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'download';
  } catch {
    return 'download';
  }
}

export { formatBytes };
