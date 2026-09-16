'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileViewer } from 'lookglass/react';
import { warmCache, registerServiceWorker } from 'lookglass/react';
import type { SourceInput } from 'lookglass';

/** Files served from `examples/next-app/files` through the range handler. */
const SERVER_FILES = [
  { label: 'app.log (large, ~40k lines)', path: 'app.log' },
  { label: 'notes.txt', path: 'notes.txt' },
  { label: 'logo.png', path: 'logo.png' },
  { label: 'report.pdf (renderer lands in M2)', path: 'report.pdf' },
];

export function ViewerShell() {
  const [source, setSource] = useState<SourceInput | null>(null);
  const [label, setLabel] = useState<string>('');
  const [online, setOnline] = useState(true);
  const [warm, setWarm] = useState<string>('');
  const [updateReady, setUpdateReady] = useState<(() => void) | null>(null);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    void registerServiceWorker({
      url: '/sw.js',
      // Never auto-activate: swapping the cache generation under a live page
      // breaks its already-resolved lazy import URLs.
      onUpdateReady: (activate) => setUpdateReady(() => activate),
    });
  }, []);

  // Warm the offline cache once the page is idle, not during first paint.
  useEffect(() => {
    const schedule =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback
        : (fn: () => void) => setTimeout(fn, 1500);
    const handle = schedule(() => {
      void warmCache().then((result) => {
        setWarm(
          `renderers cached: ${result.renderers.loaded.length}` +
            (result.renderers.failed.length ? `, failed: ${result.renderers.failed.join(', ')}` : ''),
        );
      });
    });
    return () => {
      if (typeof cancelIdleCallback === 'function' && typeof handle === 'number') cancelIdleCallback(handle);
    };
  }, []);

  const onPickLocal = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    // A File is used directly: no copy, no upload, and Blob.slice gives the
    // viewer free range access to it.
    setSource(file);
    setLabel(file.name);
  }, []);

  const onPickServer = useCallback((path: string, text: string) => {
    setSource({ url: `/api/files/${path}`, name: path });
    setLabel(text);
  }, []);

  return (
    <main className="shell">
      <header className="shell-header">
        <h1>lookglass</h1>
        <span className={online ? 'pill pill-online' : 'pill pill-offline'}>{online ? 'online' : 'offline'}</span>
        {warm ? <span className="hint">{warm}</span> : null}
        {updateReady ? (
          <button type="button" className="update" onClick={() => updateReady()}>
            New version — reload
          </button>
        ) : null}
      </header>

      <div className="shell-body">
        <aside className="sidebar">
          <section>
            <h2>Local file</h2>
            <p className="hint">Never uploaded. Read straight off disk.</p>
            <input type="file" onChange={onPickLocal} />
          </section>

          <section>
            <h2>From the server</h2>
            <p className="hint">Served with HTTP ranges, cached to OPFS for offline.</p>
            <ul>
              {SERVER_FILES.map((file) => (
                <li key={file.path}>
                  <button type="button" onClick={() => onPickServer(file.path, file.label)}>
                    {file.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {source ? (
            <button type="button" className="clear" onClick={() => setSource(null)}>
              Close document
            </button>
          ) : null}
        </aside>

        <div className="viewer" data-testid="viewer">
          <FileViewer
            source={source}
            // Remote documents are streamed to OPFS on first open; local files
            // are already local so this has no effect on them.
            offline={{ cache: true }}
            className="lookglass"
            renderEmpty={() => <div className="empty">Pick a file to preview{label ? ` (${label})` : ''}</div>}
          />
        </div>
      </div>
    </main>
  );
}
