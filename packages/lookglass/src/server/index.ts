import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, resolve, sep, extname } from 'node:path';
import { Readable } from 'node:stream';
import { EXTENSION_MAP } from '../detect/signatures.js';

/**
 * Range-capable file serving for Next.js route handlers.
 *
 * This is the server half of the large-file story. Without `Range` support,
 * opening page 400 of a 1 GB PDF downloads a gigabyte; with it, the viewer
 * fetches a few kB. Next.js serves `public/` with ranges already, but
 * anything behind auth or outside `public/` goes through a route handler,
 * and a hand-written one almost always returns 200 with the whole body.
 *
 * Correctness details that matter here: `If-Range` must invalidate a range
 * request when the file changed mid-download, multi-range requests are
 * answered with the full body rather than a malformed single range, and an
 * unsatisfiable range gets a 416 carrying `Content-Range: bytes * /size`.
 */

export interface FileTarget {
  size: number;
  mime: string;
  /** Strong validator. Defaults to size + mtime when serving from disk. */
  etag?: string;
  lastModified?: Date;
  filename?: string;
  /** Produce the bytes for `[start, end]` inclusive. */
  open(start: number, end: number): ReadableStream<Uint8Array>;
}

export interface RangeHandlerOptions {
  /** Return the target for a request, or undefined for a 404. */
  resolve(request: Request, context: unknown): Promise<FileTarget | undefined> | FileTarget | undefined;
  /** `Cache-Control` for 200/206 responses. */
  cacheControl?: string;
  /** Force a download instead of inline display. */
  download?: boolean;
}

export type RouteHandler = (request: Request, context: unknown) => Promise<Response>;

export function createRangeHandler(opts: RangeHandlerOptions): RouteHandler {
  const cacheControl = opts.cacheControl ?? 'private, max-age=0, must-revalidate';

  return async function handler(request: Request, context: unknown): Promise<Response> {
    const target = await opts.resolve(request, context);
    if (!target) return new Response('Not found', { status: 404 });

    const etag = target.etag;
    const baseHeaders = new Headers({
      'accept-ranges': 'bytes',
      'content-type': target.mime,
      'cache-control': cacheControl,
    });
    if (etag) baseHeaders.set('etag', etag);
    if (target.lastModified) baseHeaders.set('last-modified', target.lastModified.toUTCString());
    if (target.filename) {
      baseHeaders.set(
        'content-disposition',
        `${opts.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(target.filename)}`,
      );
    }

    // Conditional GET: cheap win, and it keeps repeat opens instant.
    const ifNoneMatch = request.headers.get('if-none-match');
    if (etag && ifNoneMatch && matchesEtag(ifNoneMatch, etag)) {
      return new Response(null, { status: 304, headers: baseHeaders });
    }

    if (request.method === 'HEAD') {
      baseHeaders.set('content-length', String(target.size));
      return new Response(null, { status: 200, headers: baseHeaders });
    }

    const rangeHeader = request.headers.get('range');
    const ifRange = request.headers.get('if-range');

    // `If-Range` that no longer matches means the client's cached prefix is
    // stale: serve the whole file rather than a range it would splice wrongly.
    const rangeAllowed =
      rangeHeader !== null && (ifRange === null || (etag !== undefined && matchesEtag(ifRange, etag)));

    if (rangeAllowed) {
      const range = parseRange(rangeHeader, target.size);

      if (range === 'unsatisfiable') {
        const headers = new Headers(baseHeaders);
        headers.set('content-range', `bytes */${target.size}`);
        return new Response(null, { status: 416, headers });
      }

      if (range !== 'ignore') {
        const { start, end } = range;
        const headers = new Headers(baseHeaders);
        headers.set('content-range', `bytes ${start}-${end}/${target.size}`);
        headers.set('content-length', String(end - start + 1));
        return new Response(target.open(start, end), { status: 206, headers });
      }
    }

    baseHeaders.set('content-length', String(target.size));
    return new Response(target.open(0, Math.max(0, target.size - 1)), { status: 200, headers: baseHeaders });
  };
}

/* ------------------------------------------------------------------ *
 * Disk-backed convenience handler
 * ------------------------------------------------------------------ */

export interface FileRangeHandlerOptions extends Omit<RangeHandlerOptions, 'resolve'> {
  /** Directory files are served from. Nothing outside it is reachable. */
  root: string;
  /** Map a request to a path relative to `root`. Defaults to the URL path. */
  resolvePath?: (request: Request, context: unknown) => string | undefined | Promise<string | undefined>;
}

/**
 * Serve a directory with ranges, ETags and traversal protection.
 *
 * Guard the handler with your own auth check before calling it — this helper
 * deliberately has no opinion about who is allowed to read what.
 */
export function createFileRangeHandler(opts: FileRangeHandlerOptions): RouteHandler {
  const root = resolve(opts.root);

  return createRangeHandler({
    ...opts,
    async resolve(request, context) {
      const requested = (await opts.resolvePath?.(request, context)) ?? new URL(request.url).pathname;
      const relative = safeRelativePath(requested);
      if (relative === undefined) return undefined;

      const absolute = join(root, relative);
      // Re-check after joining: `..` segments and symlink-ish inputs must not
      // escape the root, and normalising first is not sufficient on its own.
      if (absolute !== root && !absolute.startsWith(root + sep)) return undefined;

      let stats;
      try {
        stats = await stat(absolute);
      } catch {
        return undefined;
      }
      if (!stats.isFile()) return undefined;

      return {
        size: stats.size,
        mime: mimeFor(absolute),
        etag: `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`,
        lastModified: stats.mtime,
        filename: absolute.split(sep).pop(),
        open(start, end) {
          // `end` is inclusive for both HTTP ranges and createReadStream, so
          // it passes through unchanged.
          return Readable.toWeb(createReadStream(absolute, { start, end })) as ReadableStream<Uint8Array>;
        },
      };
    },
  });
}

/* ------------------------------ helpers ------------------------------ */

type ParsedRange = { start: number; end: number } | 'ignore' | 'unsatisfiable';

/**
 * Parse a single byte range. Multi-range requests return `ignore`, which
 * answers with the full body — a valid response, and far safer than emitting
 * a multipart/byteranges body that most clients handle poorly.
 */
export function parseRange(header: string, size: number): ParsedRange {
  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match) return 'ignore';

  const specs = match[1]!.split(',');
  if (specs.length !== 1) return 'ignore';

  const spec = specs[0]!.trim();
  const [startRaw = '', endRaw = ''] = spec.split('-');

  if (size === 0) return 'unsatisfiable';

  if (startRaw === '') {
    // Suffix form: `bytes=-500` means the last 500 bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) return 'ignore';
  if (start >= size) return 'unsatisfiable';

  const end = endRaw === '' ? size - 1 : Number(endRaw);
  if (!Number.isFinite(end) || end < start) return 'ignore';

  return { start, end: Math.min(end, size - 1) };
}

function matchesEtag(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  const normalise = (value: string) => value.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => normalise(candidate) === normalise(etag));
}

function safeRelativePath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  // NUL bytes truncate paths in some syscalls; reject rather than sanitise.
  if (decoded.includes('\0')) return undefined;
  const normalised = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  return normalised.replace(/^[/\\]+/, '');
}

function mimeFor(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return EXTENSION_MAP[ext]?.mime ?? 'application/octet-stream';
}
