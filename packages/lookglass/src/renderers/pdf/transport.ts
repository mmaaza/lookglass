'use client';

import type { PDFDataRangeTransport } from 'pdfjs-dist';
import { isAbort } from '../../core/errors.js';
import type { Source } from '../../source/types.js';

export interface TransportStats {
  /** Bytes actually fetched through range requests, excluding initial data. */
  bytesRequested: number;
  requests: number;
}

/**
 * Feeds PDF.js from a lookglass `Source`.
 *
 * PDF.js can fetch URLs itself, but only URLs. Routing every read through the
 * `Source` means one loading path for all three origins — a local `File`, an
 * HTTP range, or an OPFS copy on disk — and it inherits the source's headers,
 * credentials, cancellation and non-range fallback instead of reimplementing
 * them inside PDF.js's worker.
 *
 * With `disableAutoFetch`, PDF.js asks only for the byte ranges the pages on
 * screen need, so jumping to page 1500 of a large file reads kilobytes rather
 * than the file.
 */
export function createSourceTransport(
  Transport: typeof PDFDataRangeTransport,
  source: Source,
  length: number,
  initialData: Uint8Array,
  signal: AbortSignal,
  onError: (error: unknown) => void,
): { transport: PDFDataRangeTransport; stats: TransportStats } {
  const stats: TransportStats = { bytesRequested: 0, requests: 0 };

  class SourceTransport extends Transport {
    override requestDataRange(begin: number, end: number): void {
      stats.requests++;
      stats.bytesRequested += end - begin;
      source.slice(begin, end, signal).then(
        (chunk) => {
          if (!signal.aborted) this.onDataRange(begin, chunk);
        },
        (err: unknown) => {
          // PDF.js has no error channel on a range transport: a failed range
          // leaves its page promise pending forever. Report it so the renderer
          // can fail the load visibly instead of showing a blank page.
          if (!isAbort(err) && !signal.aborted) onError(err);
        },
      );
    }

    override abort(): void {
      // Nothing to do here: in-flight reads are bound to the load signal,
      // which the renderer aborts on dispose.
    }
  }

  return { transport: new SourceTransport(length, initialData), stats };
}
