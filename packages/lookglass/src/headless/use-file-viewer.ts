'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoadToken } from '../core/cancel.js';
import { ViewerError, isAbort } from '../core/errors.js';
import { openDocument, type OfflineOptions } from '../core/open.js';
import type { OpenedDoc, RendererOptions } from '../core/renderer.js';
import { registerDefaultRenderers } from '../renderers/defaults.js';
import type { Source, SourceInput } from '../source/types.js';
import type { DetectedFormat, LoadProgress } from '../types.js';

export type ViewerStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseFileViewerOptions {
  /** `null`/`undefined` leaves the viewer idle. */
  source?: SourceInput | null;
  offline?: OfflineOptions;
  options?: Partial<RendererOptions>;
  /** Skip detection and force a renderer, e.g. to read anything as text. */
  forceKind?: DetectedFormat['kind'];
  onLoad?: (doc: OpenedDoc, format: DetectedFormat) => void;
  onError?: (error: ViewerError) => void;
}

/** A document is waiting for a password. Present a form, then call one of these. */
export interface PasswordPrompt {
  /** 1 on the first request; higher means the last password was wrong. */
  attempt: number;
  submit(password: string): void;
  cancel(): void;
}

export interface FileViewerResult {
  status: ViewerStatus;
  progress: LoadProgress;
  error: ViewerError | undefined;
  doc: OpenedDoc | undefined;
  format: DetectedFormat | undefined;
  source: Source | undefined;
  /** True when the bytes came from the offline cache rather than the network. */
  fromCache: boolean;
  /**
   * Set while a document is waiting for a password, unless the consumer
   * supplied its own `options.requestPassword`.
   */
  passwordPrompt: PasswordPrompt | undefined;
  reload: () => void;
  cancel: () => void;
}

const IDLE: LoadProgress = { phase: 'idle' };

/**
 * Headless viewer state machine.
 *
 * All lifecycle correctness lives here so the chrome stays presentational:
 * the effect owns one `LoadToken` per attempt, and its cleanup aborts the
 * fetch, terminates the worker and frees cached pages. That makes the
 * unhappy paths — unmount mid-parse, a new file chosen while the previous is
 * still loading, React StrictMode's double-invoke — all resolve to the same
 * single teardown path rather than to leaks.
 */
export function useFileViewer(opts: UseFileViewerOptions = {}): FileViewerResult {
  const { source, offline, options, forceKind, onLoad, onError } = opts;

  const [status, setStatus] = useState<ViewerStatus>('idle');
  const [progress, setProgress] = useState<LoadProgress>(IDLE);
  const [error, setError] = useState<ViewerError | undefined>();
  const [doc, setDoc] = useState<OpenedDoc | undefined>();
  const [format, setFormat] = useState<DetectedFormat | undefined>();
  const [resolved, setResolved] = useState<Source | undefined>();
  const [fromCache, setFromCache] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const tokenRef = useRef<LoadToken | undefined>(undefined);
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt | undefined>();
  /** Resolver for an open prompt, so teardown can release a waiting load. */
  const pendingPassword = useRef<((password: string | null) => void) | undefined>(undefined);

  // Callbacks are read through a ref so a consumer passing inline arrows does
  // not restart the load on every render.
  const callbacks = useRef({ onLoad, onError });
  callbacks.current = { onLoad, onError };

  useEffect(() => {
    registerDefaultRenderers();
  }, []);

  useEffect(() => {
    if (source === null || source === undefined) {
      setStatus('idle');
      setProgress(IDLE);
      setDoc(undefined);
      setFormat(undefined);
      setResolved(undefined);
      setError(undefined);
      return;
    }

    let live = true;
    const token = new LoadToken();
    tokenRef.current = token;

    setStatus('loading');
    setError(undefined);
    setProgress({ phase: 'resolving' });

    // Built-in prompt, used only when the consumer did not provide one. The
    // load waits on this promise; the chrome resolves it from a form.
    const requestPassword =
      options?.requestPassword ??
      ((attempt: number) =>
        new Promise<string | null>((resolve) => {
          const settle = (password: string | null) => {
            pendingPassword.current = undefined;
            if (live) setPasswordPrompt(undefined);
            resolve(password);
          };
          pendingPassword.current = settle;
          if (live) {
            setPasswordPrompt({ attempt, submit: (password) => settle(password), cancel: () => settle(null) });
          }
        }));

    void openDocument({
      source,
      token,
      forceKind,
      offline,
      options: { ...options, requestPassword },
      onProgress: (update) => {
        if (live) setProgress(update);
      },
    })
      .then((result) => {
        if (!live) {
          // Resolved after unmount — dispose rather than leaking the worker.
          void result.dispose();
          return;
        }
        setDoc(result.doc);
        setFormat(result.format);
        setResolved(result.source);
        setFromCache(result.fromCache);
        setStatus('ready');
        setProgress({ phase: 'ready' });
        callbacks.current.onLoad?.(result.doc, result.format);
      })
      .catch((err: unknown) => {
        if (!live || isAbort(err)) return;
        const viewerError = ViewerError.from(err);
        setError(viewerError);
        setStatus('error');
        setProgress({ phase: 'error', message: viewerError.userMessage });
        callbacks.current.onError?.(viewerError);
      });

    return () => {
      live = false;
      // A prompt left open would keep the abandoned load waiting forever.
      pendingPassword.current?.(null);
      setPasswordPrompt(undefined);
      void token.dispose();
      if (tokenRef.current === token) tokenRef.current = undefined;
    };
    // `offline` and `options` are intentionally excluded: they are config
    // objects that consumers usually build inline, and including them would
    // reload the document on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, forceKind, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const cancel = useCallback(() => {
    tokenRef.current?.abort();
    setStatus('idle');
    setProgress(IDLE);
  }, []);

  return useMemo(
    () => ({ status, progress, error, doc, format, source: resolved, fromCache, passwordPrompt, reload, cancel }),
    [status, progress, error, doc, format, resolved, fromCache, passwordPrompt, reload, cancel],
  );
}
