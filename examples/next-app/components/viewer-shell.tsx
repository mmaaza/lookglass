'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileViewer } from 'lookglass/react';
import { warmCache, registerServiceWorker } from 'lookglass/react';
import type { SourceInput } from 'lookglass';

/** Files served from `examples/next-app/files` through the range handler. */
const SERVER_FILES = [
  { label: 'app.log (large, ~40k lines)', path: 'app.log' },
  { label: 'catalog.json (25k records)', path: 'catalog.json' },
  { label: 'events.jsonl', path: 'events.jsonl' },
  { label: 'catalog.xml (4k items)', path: 'catalog.xml' },
  { label: 'guide.md', path: 'guide.md' },
  { label: 'widget.ts (syntax highlighted)', path: 'widget.ts' },
  { label: 'diagram.svg (carries XSS payloads)', path: 'diagram.svg' },
  { label: 'notes.txt', path: 'notes.txt' },
  { label: 'logo.png', path: 'logo.png' },
  { label: 'big.pdf (1,200 pages, 11 MB)', path: 'big.pdf' },
  { label: 'cjk.pdf (needs CMap assets)', path: 'cjk.pdf' },
  { label: 'locked.pdf (password: lookglass)', path: 'locked.pdf' },
  { label: 'report.docx (301 pages, outline, lists)', path: 'report.docx' },
  { label: 'flow.docx (20k paragraphs, no page breaks)', path: 'flow.docx' },
  { label: 'locked.docx (password protected)', path: 'locked.docx' },
  { label: 'memo.doc (Word 97-2003)', path: 'memo.doc' },
  { label: 'sales.xlsx (4 sheets, 120k rows)', path: 'sales.xlsx' },
  { label: 'orders.csv (400k rows, 12 MB)', path: 'orders.csv' },
  { label: 'european.csv (semicolons)', path: 'european.csv' },
  { label: 'unicode.tsv (UTF-16)', path: 'unicode.tsv' },
  { label: 'legacy.xls (Excel 97)', path: 'legacy.xls' },
  { label: 'budget.ods (OpenDocument)', path: 'budget.ods' },
  { label: 'export.xls (HTML table)', path: 'export.xls' },
  { label: 'archive.zip (unsupported)', path: 'archive.zip' },
];

export function ViewerShell() {
  const [source, setSource] = useState<SourceInput | null>(null);
  const [label, setLabel] = useState<string>('');
  const [online, setOnline] = useState(true);
  const [warm, setWarm] = useState<string>('');
  const [updateReady, setUpdateReady] = useState<(() => void) | null>(null);
  const [cachedNote, setCachedNote] = useState('');
  // `?offline=0` turns off OPFS caching, so range loading can be observed on
  // its own without a background download running alongside it.
  const [offlineEnabled, setOfflineEnabled] = useState(true);
  useEffect(() => {
    setOfflineEnabled(new URLSearchParams(window.location.search).get('offline') !== '0');
  }, []);

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
    if (process.env.NODE_ENV !== 'production') {
      // No service worker under `next dev`: dev chunks are not content-hashed,
      // and a worker left over from a production run would keep serving old
      // code. Remove any such worker and its caches so dev always runs fresh.
      void navigator.serviceWorker
        ?.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())));
      void globalThis.caches
        ?.keys()
        .then((keys) => Promise.all(keys.filter((key) => key.startsWith('lookglass-')).map((key) => caches.delete(key))));
      return;
    }

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
          `renderers cached: ${result.renderers.loaded.length}, grammars: ${result.highlighting.loaded.length}` +
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
    setCachedNote('');
  }, []);

  return (
    <main className="shell">
      <header className="shell-header">
        <h1>lookglass</h1>
        <span className={online ? 'pill pill-online' : 'pill pill-offline'}>{online ? 'online' : 'offline'}</span>
        {warm ? <span className="hint">{warm}</span> : null}
        {cachedNote ? (
          <span className="hint" data-testid="cached-note">
            {cachedNote}
          </span>
        ) : null}
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
            offline={{
              cache: offlineEnabled,
              onCached: () => setCachedNote(`saved offline: ${label}`),
            }}
            className="lookglass"
            renderEmpty={() => <div className="empty">Pick a file to preview{label ? ` (${label})` : ''}</div>}
          />
        </div>
      </div>
    </main>
  );
}
