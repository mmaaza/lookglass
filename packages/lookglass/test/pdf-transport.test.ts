import { describe, expect, it, vi } from 'vitest';
import { createSourceTransport } from '../src/renderers/pdf/transport.js';
import { memorySource } from '../src/source/index.js';
import type { Source } from '../src/source/types.js';

/** Stand-in for pdf.js's PDFDataRangeTransport base class. */
class FakeTransport {
  ranges: [number, Uint8Array | null][] = [];
  constructor(
    public length: number,
    public initialData: Uint8Array | null,
  ) {}
  onDataRange(begin: number, chunk: Uint8Array | null) {
    this.ranges.push([begin, chunk]);
  }
  requestDataRange(_begin: number, _end: number) {
    throw new Error('abstract');
  }
  abort() {}
}

const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createSourceTransport', () => {
  it('serves requested ranges from the source', async () => {
    const { transport } = createSourceTransport(
      FakeTransport as never,
      memorySource(bytes, 'a.pdf'),
      bytes.length,
      bytes.subarray(0, 100),
      new AbortController().signal,
      () => undefined,
    );
    transport.requestDataRange(200, 260);
    await flush();
    const [[begin, chunk]] = (transport as unknown as FakeTransport).ranges as [[number, Uint8Array]];
    expect(begin).toBe(200);
    expect([...chunk]).toEqual([...bytes.subarray(200, 260)]);
  });

  it('counts the bytes range loading actually requested', async () => {
    const { transport, stats } = createSourceTransport(
      FakeTransport as never,
      memorySource(bytes, 'a.pdf'),
      bytes.length,
      bytes.subarray(0, 100),
      new AbortController().signal,
      () => undefined,
    );
    transport.requestDataRange(0, 64);
    transport.requestDataRange(500, 600);
    await flush();
    expect(stats).toEqual({ requests: 2, bytesRequested: 164 });
  });

  it('reports a failed range instead of leaving the page pending', async () => {
    // PDF.js has no error channel on a range transport, so without this the
    // page that needed the range would wait forever.
    const failing = {
      ...memorySource(bytes, 'a.pdf'),
      slice: () => Promise.reject(new Error('network down')),
    } as Source;
    const onError = vi.fn();
    const { transport } = createSourceTransport(
      FakeTransport as never,
      failing,
      bytes.length,
      bytes.subarray(0, 100),
      new AbortController().signal,
      onError,
    );
    transport.requestDataRange(0, 10);
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect((transport as unknown as FakeTransport).ranges).toHaveLength(0);
  });

  it('drops data and stays silent once the load is aborted', async () => {
    const controller = new AbortController();
    const onError = vi.fn();
    const { transport } = createSourceTransport(
      FakeTransport as never,
      memorySource(bytes, 'a.pdf'),
      bytes.length,
      bytes.subarray(0, 100),
      controller.signal,
      onError,
    );
    transport.requestDataRange(0, 10);
    controller.abort();
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect((transport as unknown as FakeTransport).ranges).toHaveLength(0);
  });
});
