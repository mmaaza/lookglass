import { ViewerError } from './errors.js';
import { createRpcClient, type RpcClient, type RpcHandlers } from './rpc.js';

/**
 * Worker lifecycle, keyed by document.
 *
 * One worker per open document, terminated when that document is disposed.
 * That is stricter than a shared pool but it is the only arrangement where
 * closing a viewer reliably frees the parsed model — and for these formats
 * the parsed model is the memory, not the UI.
 */

export type WorkerFactory = () => Worker;

/**
 * Bundler escape hatch.
 *
 * Renderers construct workers with `new Worker(new URL('./x.worker.js',
 * import.meta.url), { type: 'module' })`, which webpack, Turbopack and Vite
 * all understand. Environments that rewrite or strip that pattern can supply
 * their own resolver instead, and self-hosted deployments can point it at a
 * copied asset path. Never resolve a worker from a CDN: this package has to
 * keep working offline.
 */
export type WorkerResolver = (name: WorkerName, fallback: WorkerFactory) => Worker;

export type WorkerName = 'text' | 'pdf' | 'sheet' | 'docx' | 'pptx' | 'tree';

let resolver: WorkerResolver | undefined;

export function setWorkerResolver(next: WorkerResolver | undefined): void {
  resolver = next;
}

export function createWorker(name: WorkerName, fallback: WorkerFactory): Worker {
  try {
    return resolver ? resolver(name, fallback) : fallback();
  } catch (err) {
    throw new ViewerError(
      'worker-failed',
      `Could not start the ${name} worker. If your bundler rewrites worker URLs, set a custom resolver via setWorkerResolver().`,
      { cause: err, retryable: false },
    );
  }
}

interface Lease {
  key: string;
  client: RpcClient<RpcHandlers>;
  worker: Worker;
  refs: number;
  lastUsed: number;
}

export interface WorkerPoolOptions {
  /**
   * Hard ceiling on live workers. Each one is an OS thread with its own heap,
   * so an unbounded pool is a real resource leak when a user opens many tabs
   * of documents. Oldest idle worker is terminated when the cap is hit.
   */
  maxWorkers?: number;
}

export class WorkerPool {
  private readonly leases = new Map<string, Lease>();
  private readonly maxWorkers: number;

  constructor(opts: WorkerPoolOptions = {}) {
    this.maxWorkers = Math.max(1, opts.maxWorkers ?? defaultMaxWorkers());
  }

  get size(): number {
    return this.leases.size;
  }

  /**
   * Get (or start) the worker for `key`. Repeated calls with the same key
   * share one thread and bump a refcount.
   */
  lease<T extends RpcHandlers>(key: string, name: WorkerName, factory: WorkerFactory): RpcClient<T> {
    const existing = this.leases.get(key);
    if (existing && !existing.client.terminated) {
      existing.refs++;
      existing.lastUsed = Date.now();
      return existing.client as RpcClient<T>;
    }

    this.evictIdle();

    const worker = createWorker(name, factory);
    const client = createRpcClient<RpcHandlers>(worker, `${name} worker`);
    this.leases.set(key, { key, client, worker, refs: 1, lastUsed: Date.now() });
    return client as unknown as RpcClient<T>;
  }

  /** Drop a reference; the worker is terminated when the last one goes. */
  release(key: string): void {
    const lease = this.leases.get(key);
    if (!lease) return;
    lease.refs--;
    if (lease.refs <= 0) {
      lease.client.terminate();
      this.leases.delete(key);
    }
  }

  /** Terminate immediately regardless of refcount. Used on hard teardown. */
  terminate(key: string): void {
    const lease = this.leases.get(key);
    if (!lease) return;
    lease.client.terminate();
    this.leases.delete(key);
  }

  terminateAll(): void {
    for (const lease of this.leases.values()) lease.client.terminate();
    this.leases.clear();
  }

  private evictIdle(): void {
    if (this.leases.size < this.maxWorkers) return;
    let oldest: Lease | undefined;
    for (const lease of this.leases.values()) {
      if (lease.refs > 0) continue;
      if (!oldest || lease.lastUsed < oldest.lastUsed) oldest = lease;
    }
    if (oldest) {
      this.terminate(oldest.key);
      return;
    }
    // Every worker is still referenced. Terminating one would break a live
    // view, so allow the overshoot and warn instead.
    console.warn(
      `[lookglass] ${this.leases.size} workers are all in use (cap ${this.maxWorkers}). ` +
        'Dispose viewers you are no longer showing.',
    );
  }
}

function defaultMaxWorkers(): number {
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4;
  return Math.max(2, Math.min(6, Math.floor(cores / 2)));
}

let shared: WorkerPool | undefined;

export function sharedWorkerPool(): WorkerPool {
  shared ??= new WorkerPool();
  return shared;
}
