import { abortError, isAbort } from './errors.js';

type Disposer = () => void | Promise<void>;

/**
 * A load lifetime. One token per open-document attempt.
 *
 * Owning cancellation in a single object is what makes unmount safe: a route
 * change aborts the fetch, cancels in-flight render tasks and terminates the
 * worker in one call, with no renderer needing to know about the others.
 */
export class LoadToken {
  private readonly controller = new AbortController();
  private readonly disposers: Disposer[] = [];
  private disposed = false;

  constructor(parent?: AbortSignal) {
    if (parent) {
      if (parent.aborted) this.controller.abort(parent.reason);
      else parent.addEventListener('abort', () => this.controller.abort(parent.reason), { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  /** Register cleanup to run on `dispose()`. Runs LIFO. */
  onDispose(fn: Disposer): void {
    if (this.disposed) {
      void fn();
      return;
    }
    this.disposers.push(fn);
  }

  /** Throw if the load has been cancelled. Call between expensive stages. */
  throwIfAborted(): void {
    if (this.controller.signal.aborted) throw abortError();
  }

  abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason ?? abortError());
  }

  /** Abort, then run every disposer. Safe to call more than once. */
  async dispose(): Promise<void> {
    this.abort();
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.disposers.length - 1; i >= 0; i--) {
      try {
        await this.disposers[i]!();
      } catch (err) {
        if (!isAbort(err)) console.warn('[lookglass] disposer failed', err);
      }
    }
    this.disposers.length = 0;
  }
}

/** Reject as soon as `signal` aborts, otherwise settle with the promise. */
export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Yield to the event loop so a long synchronous loop cannot freeze the frame.
 * Prefers `scheduler.yield()` where available.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}
