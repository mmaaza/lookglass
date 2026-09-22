import { ViewerError } from './errors.js';
import type { LoadProgress } from '../types.js';

/**
 * Minimal request/response RPC over `postMessage`, with cancellation and
 * progress. Deliberately not Comlink: we need three things Comlink does not
 * give us cheaply — per-call abort that actually reaches the worker, progress
 * events mid-call, and zero dependencies in the worker bundle.
 *
 * The important consequence for large files is the `transfer` list: parsed
 * buffers move between threads without being copied, so handing a 200 MB
 * typed array to the UI costs nothing.
 */

const PROTOCOL = 'lg1';

type CallMessage = { lg: typeof PROTOCOL; id: number; method: string; args: unknown };
type CancelMessage = { lg: typeof PROTOCOL; id: number; cancel: true };
type ResultMessage = { lg: typeof PROTOCOL; id: number; ok: true; value: unknown };
type ErrorMessage = {
  lg: typeof PROTOCOL;
  id: number;
  ok: false;
  error: { code: string; message: string; detail?: Record<string, unknown> };
};
type ProgressMessage = { lg: typeof PROTOCOL; id: number; progress: LoadProgress };

type Inbound = CallMessage | CancelMessage;
type Outbound = ResultMessage | ErrorMessage | ProgressMessage;

/** Shape a worker module exposes: async methods taking one argument. */
export type RpcHandlers = Record<string, (args: never, ctx: RpcContext) => unknown>;

export interface RpcContext {
  /** Aborts when the caller cancels. Check it inside long loops. */
  signal: AbortSignal;
  /** Report intermediate progress to the caller. */
  progress(update: LoadProgress): void;
  /** Buffers to transfer (not copy) with the result. */
  transfer(...items: Transferable[]): void;
}

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (update: LoadProgress) => void;
  /** Buffers to hand to the worker without copying. */
  transfer?: Transferable[];
  /** Fail the call after this many ms. Off by default. */
  timeoutMs?: number;
}

export interface RpcClient<T extends RpcHandlers> {
  call<K extends keyof T & string>(
    method: K,
    args: Parameters<T[K]>[0],
    opts?: CallOptions,
  ): Promise<Awaited<ReturnType<T[K]>>>;
  /** Abort every in-flight call and terminate the worker. */
  terminate(): void;
  readonly terminated: boolean;
}

/* ------------------------------ client ------------------------------ */

export function createRpcClient<T extends RpcHandlers>(worker: Worker, label = 'worker'): RpcClient<T> {
  interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    onProgress?: (update: LoadProgress) => void;
    cleanup: () => void;
  }

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let terminated = false;
  /**
   * Set once the worker has failed. A module worker that throws while loading
   * fires `error` before any call is pending, so without remembering the
   * failure the first call would be posted to a dead thread and never settle.
   */
  let failure: ViewerError | undefined;

  const settleAll = (error: unknown) => {
    for (const entry of pending.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    pending.clear();
  };

  worker.addEventListener('message', (event: MessageEvent<Outbound>) => {
    const message = event.data;
    if (!message || message.lg !== PROTOCOL) return;
    const entry = pending.get(message.id);
    if (!entry) return;

    if ('progress' in message) {
      entry.onProgress?.(message.progress);
      return;
    }

    pending.delete(message.id);
    entry.cleanup();
    if (message.ok) entry.resolve(message.value);
    else {
      entry.reject(
        new ViewerError(message.error.code as ViewerError['code'], message.error.message, {
          detail: message.error.detail,
        }),
      );
    }
  });

  worker.addEventListener('error', (event) => {
    // A worker-level error means the thread is unusable; fail everything
    // rather than leaving calls hanging forever.
    const error = new ViewerError('worker-failed', `${label} crashed: ${event.message || 'unknown error'}`, {
      retryable: true,
    });
    failure = error;
    settleAll(error);
  });

  worker.addEventListener('messageerror', () => {
    settleAll(
      new ViewerError('worker-failed', `${label} received a value it could not deserialise.`, { retryable: false }),
    );
  });

  return {
    get terminated() {
      return terminated;
    },

    call(method, args, opts = {}) {
      if (failure) return Promise.reject(failure);
      if (terminated) {
        return Promise.reject(new ViewerError('worker-failed', `${label} has been terminated.`));
      }

      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout =
          opts.timeoutMs !== undefined
            ? setTimeout(() => {
                pending.get(id)?.cleanup();
                pending.delete(id);
                worker.postMessage({ lg: PROTOCOL, id, cancel: true } satisfies CancelMessage);
                reject(new ViewerError('worker-failed', `${label}.${method} timed out.`, { retryable: true }));
              }, opts.timeoutMs)
            : undefined;

        const onAbort = () => {
          pending.get(id)?.cleanup();
          pending.delete(id);
          // Tell the worker to stop; otherwise it keeps burning CPU on work
          // nobody is waiting for, which is exactly what kills scroll
          // performance on large documents.
          worker.postMessage({ lg: PROTOCOL, id, cancel: true } satisfies CancelMessage);
          reject(new DOMException('Aborted', 'AbortError'));
        };

        if (opts.signal) {
          if (opts.signal.aborted) {
            onAbort();
            return;
          }
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }

        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          onProgress: opts.onProgress,
          cleanup: () => {
            if (timeout !== undefined) clearTimeout(timeout);
            opts.signal?.removeEventListener('abort', onAbort);
          },
        });

        const message: CallMessage = { lg: PROTOCOL, id, method, args };
        if (opts.transfer?.length) worker.postMessage(message, opts.transfer);
        else worker.postMessage(message);
      });
    },

    terminate() {
      if (terminated) return;
      terminated = true;
      settleAll(new DOMException('Aborted', 'AbortError'));
      worker.terminate();
    },
  };
}

/* ------------------------------ worker side ------------------------------ */

/**
 * Call once at the top of a worker module. Handlers receive an `RpcContext`
 * whose `signal` aborts when the caller cancels — long loops must check it.
 */
export interface RpcWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export function exposeRpc(handlers: RpcHandlers, scope: RpcWorkerScope = self as never): void {
  const running = new Map<number, AbortController>();

  scope.addEventListener('message', async (event: MessageEvent<Inbound>) => {
    const message = event.data;
    if (!message || message.lg !== PROTOCOL) return;

    if ('cancel' in message) {
      running.get(message.id)?.abort();
      running.delete(message.id);
      return;
    }

    const { id, method, args } = message;
    const handler = handlers[method];
    if (!handler) {
      scope.postMessage({
        lg: PROTOCOL,
        id,
        ok: false,
        error: { code: 'internal', message: `Unknown method "${method}".` },
      } satisfies ErrorMessage);
      return;
    }

    const controller = new AbortController();
    running.set(id, controller);
    const transferables: Transferable[] = [];

    const ctx: RpcContext = {
      signal: controller.signal,
      progress: (update) => {
        if (controller.signal.aborted) return;
        scope.postMessage({ lg: PROTOCOL, id, progress: update } satisfies ProgressMessage);
      },
      transfer: (...items) => transferables.push(...items),
    };

    try {
      const value = await handler(args as never, ctx);
      if (controller.signal.aborted) return;
      const result: ResultMessage = { lg: PROTOCOL, id, ok: true, value };
      if (transferables.length) scope.postMessage(result, transferables);
      else scope.postMessage(result);
    } catch (err) {
      if (controller.signal.aborted) return;
      const viewerError = ViewerError.from(err);
      scope.postMessage({
        lg: PROTOCOL,
        id,
        ok: false,
        error: {
          code: viewerError.code,
          message: viewerError.userMessage,
          detail: viewerError.detail,
        },
      } satisfies ErrorMessage);
    } finally {
      running.delete(id);
    }
  });
}
