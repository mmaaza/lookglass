import { describe, expect, it } from 'vitest';
import { createRangeHandler, parseRange } from '../src/server/index.js';

describe('parseRange', () => {
  it('parses a closed range', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  });

  it('parses an open-ended range', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range as the last N bytes', () => {
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
  });

  it('clamps an end past the file size', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('marks a start past the end of the file unsatisfiable', () => {
    expect(parseRange('bytes=2000-3000', 1000)).toBe('unsatisfiable');
  });

  it('falls back to the full body for multi-range requests', () => {
    // Deliberate: multipart/byteranges is poorly supported and easy to emit
    // incorrectly, and a 200 is always a valid answer to a range request.
    expect(parseRange('bytes=0-10,20-30', 1000)).toBe('ignore');
  });

  it('ignores malformed headers', () => {
    expect(parseRange('items=0-10', 1000)).toBe('ignore');
    expect(parseRange('bytes=abc-def', 1000)).toBe('ignore');
  });
});

describe('createRangeHandler', () => {
  const body = new TextEncoder().encode('0123456789'.repeat(10)); // 100 bytes

  const handler = createRangeHandler({
    resolve: () => ({
      size: body.length,
      mime: 'text/plain',
      etag: '"abc123"',
      open(start, end) {
        const slice = body.slice(start, end + 1);
        return new ReadableStream({
          start(controller) {
            controller.enqueue(slice);
            controller.close();
          },
        });
      },
    }),
  });

  const request = (headers: Record<string, string> = {}, method = 'GET') =>
    new Request('http://localhost/file.txt', { method, headers });

  it('advertises range support on a plain GET', async () => {
    const response = await handler(request(), {});
    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe('100');
  });

  it('serves 206 with a correct Content-Range', async () => {
    const response = await handler(request({ range: 'bytes=10-19' }), {});
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(response.headers.get('content-length')).toBe('10');
    expect(await response.text()).toBe('0123456789');
  });

  it('answers 416 with the total size for an unsatisfiable range', async () => {
    const response = await handler(request({ range: 'bytes=500-600' }), {});
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */100');
  });

  it('returns 304 for a matching If-None-Match', async () => {
    const response = await handler(request({ 'if-none-match': '"abc123"' }), {});
    expect(response.status).toBe(304);
  });

  it('ignores a range when If-Range no longer matches', async () => {
    // The client cached a prefix of an older version; splicing a fresh range
    // onto it would produce a corrupt file, so the whole body is correct here.
    const response = await handler(request({ range: 'bytes=0-9', 'if-range': '"stale"' }), {});
    expect(response.status).toBe(200);
  });

  it('honours a range when If-Range still matches', async () => {
    const response = await handler(request({ range: 'bytes=0-9', 'if-range': '"abc123"' }), {});
    expect(response.status).toBe(206);
  });

  it('answers HEAD without a body', async () => {
    const response = await handler(request({}, 'HEAD'), {});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('100');
    expect(await response.text()).toBe('');
  });

  it('404s when the target cannot be resolved', async () => {
    const missing = createRangeHandler({ resolve: () => undefined });
    expect((await missing(request(), {})).status).toBe(404);
  });
});
