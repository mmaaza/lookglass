# Integrating lookglass — guide for AI coding agents

Read this before adding a file previewer with `lookglass` to a project. It is a checklist, ordered by what breaks most often. Prefer it over guessing from the type definitions.

## 0. Preconditions — verify, don't assume

- Node >= 22.13; React and React DOM 18.2 or 19. The package is **ESM-only**.
- Framework: React / Next.js (App Router or Pages). Vite and other bundlers that support `new Worker(new URL(...), { type: 'module' })` also work. For Vue/Svelte/Angular, only the framework-agnostic `lookglass/headless` API (`openDocument`) applies; there is no prebuilt component.
- It is a **client-only** UI. In Next.js App Router, the component using it needs `'use client'`.
- Everything is same-origin and offline-capable: **never** point it at a CDN.

## 1. Install and copy runtime assets (required)

```bash
npm install lookglass
npx lookglass-copy-assets --sw            # add --public <dir> if the static dir is not ./public
```

This copies PDF.js cmaps/fonts to `<public>/lookglass/` (and a service worker `sw.js` with `--sw`). Without it, CJK and non-embedded-font PDFs render blank. Create the public directory first if it doesn't exist. To do this automatically in Next.js instead, wrap the config:

```js
// next.config.mjs
import { withLookglass } from 'lookglass/precache-plugin';
export default withLookglass({ reactStrictMode: true });
```

A one-off CLI run is not repeated on fresh checkouts: either commit `public/lookglass/` and `public/sw.js`, or add the CLI to a `prebuild`/`postinstall` script.

If assets are served under a different URL path, pass `options={{ assetBasePath: '/your/path' }}` (default `/lookglass`; also use `--base` with the CLI).

## 2. Minimal usage

```tsx
'use client';
import { FileViewer } from 'lookglass/react';
import 'lookglass/styles.css';   // optional; components are headless without it

export function Preview({ file }: { file: File | string }) {
  return (
    <div style={{ height: '80vh' }}>   {/* the viewer fills its parent: give it a height */}
      <FileViewer source={file} />
    </div>
  );
}
```

- `source`: `File | Blob | ArrayBuffer | string (URL) | { url, headers }`. `null`/`undefined` renders the empty state.
- The container **must have a definite height** (the viewer virtualizes and fills it). A zero-height parent is the #1 "nothing shows" cause.
- Changing `source` loads the new file and cleans up the old one; no `key` remount is needed.
- Format is detected from bytes first, so extension-less URLs and wrong MIME types are fine. Use `forceKind` only to override.

## 3. Common props

| Prop | Use |
| --- | --- |
| `offline={{ cache: true }}` | Copy remote files into OPFS in the background so later opens work offline. Not needed for local `File`s. |
| `options={{ assetBasePath, locale, maxWholeFileBytes, requestPassword }}` | Renderer options. `requestPassword` supplies your own password UI; otherwise a built-in prompt appears. |
| `options={{ rendererOptions: { 'lookglass/docx': { engine: 'native' } } }}` | Opt in to the native Word layout engine (default is `docx-preview`). |
| `hideToolbar`, `hideStatusBar`, `className` | Chrome control. |
| `renderLoading`, `renderError`, `renderEmpty` | Replace built-in states. |
| `onLoad`, `onError` | Lifecycle callbacks (`onError` receives a `ViewerError`). |

Custom UI: use `useFileViewer()` from `lookglass/headless`, then render `doc.Surface` yourself and read `doc.meta.capabilities`.

Style with `--lg-*` CSS variables on `[data-lookglass-root]` (e.g. `--lg-accent`, `--lg-radius`, `--lg-font`), or write your own rules against `data-lookglass-*` attributes.

## 4. Serving remote files

URL sources are loaded with HTTP **Range** requests. Files in `public/` already support this. For files behind auth in Next.js, use the range handler — a hand-written route that returns the whole body defeats large-file support:

```ts
// app/api/files/[...path]/route.ts
import { createFileRangeHandler } from 'lookglass/server';
import { join } from 'node:path';

const serve = createFileRangeHandler({
  root: join(process.cwd(), 'documents'),
  resolvePath: (_req, ctx) => (ctx as { params: { path: string[] } }).params.path.join('/'),
});
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  await requireSession(request);                       // your auth first
  return serve(request, { params: await context.params });
}
```

Then `source={{ url: '/api/files/report.pdf' }}`. For cross-origin URLs the server must send CORS headers and expose `Content-Range`, `Accept-Ranges` and `Content-Length`. Pass auth via `{ url, headers }`.

## 5. Offline (optional)

```tsx
import { registerServiceWorker, warmCache } from 'lookglass/react';
await registerServiceWorker({ onUpdateReady: (activate) => promptUserThenCall(activate) });
await warmCache();   // once, while online, e.g. in requestIdleCallback
```

Never call `activate` automatically; swapping the cache under a live page breaks lazy chunk imports. Let the user choose.

## 6. Entry points

| Import | Use | Environment |
| --- | --- | --- |
| `lookglass` | types, `detectFormat`, sources, `registerRenderer` | server-safe |
| `lookglass/react` | `FileViewer`, `Toolbar`, `warmCache`, `registerServiceWorker` | client only |
| `lookglass/headless` | `useFileViewer`, `useDocState`, `openDocument` | client only |
| `lookglass/server` | `createFileRangeHandler` | Node |
| `lookglass/styles.css` | optional styles | n/a |

## 7. Supported formats

PDF, DOCX, XLSX/XLS/XLSB/ODS, CSV/TSV, text, source code (highlighted), images, SVG, JSON, JSON Lines, XML, Markdown. Password-protected DOCX and legacy `.doc` are recognised but cannot be opened (a clear error is shown). **PPTX is not supported yet** — don't promise it; use `renderError` to offer a download fallback for unsupported types.

## 8. Pitfalls checklist

1. Forgot `npx lookglass-copy-assets` → blank CJK PDFs and 404s on `/lookglass/...`.
2. Parent has no height → viewer collapses.
3. Imported `lookglass/react` in a Server Component → add `'use client'`.
4. Server route ignoring `Range` → large files load slowly or fully into memory.
5. `resolve.alias` on the package or rewritten worker URLs → workers fail to load; use `setWorkerResolver` from `lookglass`.
6. Strict CSP: allow `worker-src 'self' blob:` and `connect-src` for your file origin only.
7. Don't read the file yourself and pass a giant string — pass the `File`/URL and let lookglass stream it.
8. Don't add print buttons for PDF/DOCX; they are intentionally not offered.

## 9. Verify

Run the app and open one PDF, one DOCX, one XLSX and one image. In the network tab, `/lookglass/...` requests should be 200 and file URLs should return `206` for range requests. Check the console for worker errors.

Full docs: `README.md` in this package. Types: `dist/**/*.d.ts`.
