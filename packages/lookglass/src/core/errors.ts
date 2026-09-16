import type { ViewerErrorCode } from '../types.js';

/**
 * Every failure surfaced to the consumer is a ViewerError with a stable
 * machine-readable `code`, so apps can branch without string matching.
 */
export class ViewerError extends Error {
  readonly code: ViewerErrorCode;
  /** True when retrying the same operation could plausibly succeed. */
  readonly retryable: boolean;
  /** Safe to show to an end user verbatim. */
  readonly userMessage: string;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: ViewerErrorCode,
    userMessage: string,
    opts: { cause?: unknown; retryable?: boolean; detail?: Record<string, unknown> } = {},
  ) {
    super(`[${code}] ${userMessage}`, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ViewerError';
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.detail = opts.detail;
  }

  static from(err: unknown, fallback: ViewerErrorCode = 'internal'): ViewerError {
    if (err instanceof ViewerError) return err;
    if (isAbort(err)) return new ViewerError('aborted', 'Loading was cancelled.', { cause: err });
    const message = err instanceof Error ? err.message : String(err);
    return new ViewerError(fallback, message || 'Something went wrong.', { cause: err });
  }
}

const RETRYABLE = new Set<ViewerErrorCode>(['network', 'worker-failed', 'out-of-memory', 'internal']);

/** `AbortError` identification that works across DOMException and Node. */
export function isAbort(err: unknown): boolean {
  if (err instanceof ViewerError) return err.code === 'aborted';
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export function abortError(message = 'Aborted'): DOMException {
  return new DOMException(message, 'AbortError');
}
