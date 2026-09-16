import { ViewerError } from './errors.js';
import type { RendererFactory } from './renderer.js';
import type { FormatKind } from '../types.js';

/**
 * Format -> renderer chunk mapping.
 *
 * `load` is a dynamic import, which is what keeps an image preview from
 * pulling the PDF engine into the bundle: the deps are installed eagerly, but
 * the code is fetched only when a document of that kind is actually opened.
 */
export interface RendererRegistration {
  id: string;
  kinds: FormatKind[];
  /** Lower numbers win when two renderers claim the same kind. */
  priority?: number;
  load: () => Promise<RendererFactory>;
}

class RendererRegistry {
  private readonly byId = new Map<string, RendererRegistration>();
  private readonly loaded = new Map<string, Promise<RendererFactory>>();

  register(registration: RendererRegistration): () => void {
    this.byId.set(registration.id, registration);
    return () => this.unregister(registration.id);
  }

  unregister(id: string): void {
    this.byId.delete(id);
    this.loaded.delete(id);
  }

  /** Registrations that can handle `kind`, best first. */
  candidates(kind: FormatKind): RendererRegistration[] {
    return [...this.byId.values()]
      .filter((entry) => entry.kinds.includes(kind))
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  supports(kind: FormatKind): boolean {
    return this.candidates(kind).length > 0;
  }

  kinds(): FormatKind[] {
    const kinds = new Set<FormatKind>();
    for (const entry of this.byId.values()) for (const kind of entry.kinds) kinds.add(kind);
    return [...kinds];
  }

  /**
   * Resolve and import the renderer for `kind`.
   *
   * A failed import is almost always a missing chunk offline or a bundler
   * misconfiguration, so it is reported as `renderer-missing` with the
   * renderer id rather than as a generic module error.
   */
  async resolve(kind: FormatKind): Promise<RendererFactory> {
    const candidates = this.candidates(kind);
    if (candidates.length === 0) {
      throw new ViewerError('unsupported-format', `No renderer is registered for ${kind} files.`, {
        detail: { kind, registered: this.kinds() },
        retryable: false,
      });
    }

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        let pending = this.loaded.get(candidate.id);
        if (!pending) {
          pending = candidate.load();
          this.loaded.set(candidate.id, pending);
        }
        return await pending;
      } catch (err) {
        // Do not cache a failed import: offline-then-online should recover.
        this.loaded.delete(candidate.id);
        lastError = err;
      }
    }

    throw new ViewerError(
      'renderer-missing',
      `The ${kind} viewer could not be loaded. If you are offline, it may not have been cached yet.`,
      { cause: lastError, detail: { kind }, retryable: true },
    );
  }

  /**
   * Import every registered renderer chunk.
   *
   * Called by `warmCache()` on a first online visit so the service worker
   * observes and caches the chunks before they are needed offline.
   */
  async preloadAll(): Promise<{ loaded: string[]; failed: string[] }> {
    const loaded: string[] = [];
    const failed: string[] = [];
    await Promise.all(
      [...this.byId.values()].map(async (entry) => {
        try {
          let pending = this.loaded.get(entry.id);
          if (!pending) {
            pending = entry.load();
            this.loaded.set(entry.id, pending);
          }
          await pending;
          loaded.push(entry.id);
        } catch {
          this.loaded.delete(entry.id);
          failed.push(entry.id);
        }
      }),
    );
    return { loaded, failed };
  }

  list(): RendererRegistration[] {
    return [...this.byId.values()];
  }
}

export const registry = new RendererRegistry();

export function registerRenderer(registration: RendererRegistration): () => void {
  return registry.register(registration);
}
