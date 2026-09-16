# lookglass

All-in-one, offline-capable file viewer for React and Next.js — built for files that are too big for the naive approach.

> **Status: M0 (foundation).** The core is complete and tested end to end. Text and image renderers ship as reference implementations of the renderer contract. PDF, DOCX, XLSX/CSV, PPTX, JSON, XML and Markdown land in M1–M5 — see [Roadmap](#roadmap).

```bash
npm install lookglass
npx lookglass-copy-assets --sw
```

```tsx
'use client';
import { FileViewer } from 'lookglass/react';
import 'lookglass/styles.css';

export function Preview({ file }: { file: File }) {
  return <FileViewer source={file} offline={{ cache: true }} />;
}
```

`source` accepts a `File`, `Blob`, `ArrayBuffer`, URL string, or `{ url, headers }`.

---

## Why this exists

Most file viewers work fine on the 2 MB PDF in the demo and fall over on the 800 MB one in production. lookglass is designed around four constraints that only show up at scale:

**Nothing reads a whole file unless it can afford to.** Every renderer goes through a `Source` abstraction exposing `slice()`, `stream()` and a `bytes()` escape hatch that *requires* an explicit byte ceiling. There is no unguarded `file.arrayBuffer()` anywhere in the codebase.

**The worker owns the data, the UI borrows windows of it.** Parsed models live in a worker and never cross into React state. The UI asks for the lines, rows or pages it is about to paint. A 4 GB log costs the same React memory as a 4 KB one.

**Decoded memory is budgeted in bytes, not hoped for.** Rendered canvases and bitmaps live in an LRU with real byte accounting and explicit disposal. Browsers do not report allocation failure usefully — the tab just dies — so the budget is tracked by us.

**Cancellation is one call.** A load owns a `LoadToken`; unmounting aborts the fetch, cancels in-flight renders, terminates the worker and frees cached pages through a single teardown path.

## Offline

The app works with no network, which rules out every CDN fallback the usual libraries assume.

| What | Where it lives | Why |
| --- | --- | --- |
| Renderer chunks | Cache API, cache-first | Content-hashed URLs, so a stale entry is impossible |
| PDF.js cmaps + fonts | Cache API, precached at install | Missing these is why CJK text renders as blank boxes |
| **Document bytes** | **OPFS** | Cache API cannot serve a byte range or slice a 1 GB entry. OPFS can. |

That split is the design. Caching a document to OPFS makes it *both* offline-available and no longer memory-bound, because a cached file is still `slice()`-able off disk — the same access pattern the network path uses.

```tsx
// First open streams the bytes to OPFS; later opens work with no network.
<FileViewer source={{ url: '/api/files/report.pdf' }} offline={{ cache: true }} />
```

Call `warmCache()` once on an online visit, ideally from an idle callback:

```tsx
import { warmCache, registerServiceWorker } from 'lookglass/react';

await registerServiceWorker({ onUpdateReady: (activate) => showReloadPrompt(activate) });
await warmCache();
```

This imports every registered renderer chunk and hands the current app shell to the service worker. Both steps are necessary: a build-time manifest **cannot** know the renderer chunk URLs, because your bundler re-bundles and content-hashes them. Their names only exist in your output.

### The update footgun

`registerServiceWorker` never auto-activates a waiting worker. Activating one swaps the cache generation under a page that already holds the previous build's chunk URLs, and the next lazy import dies with `Failed to fetch dynamically imported module`. The activation decision belongs to your app, so it is surfaced through `onUpdateReady` instead. `onActivate` also deliberately keeps the previous cache generation alive for the same reason.

## Serving files with range support

Next.js serves `public/` with ranges already. Anything behind auth goes through a route handler, and a hand-written one almost always returns the whole body:

```ts
// app/api/files/[...path]/route.ts
import { createFileRangeHandler } from 'lookglass/server';
import { join } from 'node:path';

const serve = createFileRangeHandler({
  root: join(process.cwd(), 'documents'),
  resolvePath: (_req, ctx) => (ctx as { params: { path: string[] } }).params.path.join('/'),
});

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  await requireSession(request);          // your auth check first
  return serve(request, { params: await context.params });
}
```

Handles `Range`, `206`, `Content-Range`, `If-Range`, `If-None-Match`/`304`, `416`, `HEAD`, and path traversal. Multi-range requests intentionally answer with the full body rather than an easily-malformed `multipart/byteranges`.

## Entry points

| Import | Contents | Environment |
| --- | --- | --- |
| `lookglass` | Types, `detectFormat`, sources, registry | **Server-safe** — no DOM |
| `lookglass/react` | `<FileViewer>`, `<Toolbar>`, `warmCache` | Client |
| `lookglass/headless` | `useFileViewer`, `useDocState`, `openDocument` | Client |
| `lookglass/server` | `createRangeHandler` | Node |
| `lookglass/sw` | Service-worker routes | Service worker |
| `lookglass/styles.css` | Optional stylesheet | — |

Dependencies are bundled, but every renderer is behind a dynamic `import()`. Install size and runtime size are independent: an image preview never fetches the PDF engine.

## Styling

Headless by default. Components carry no class names — only `data-lookglass-*` attributes — and `styles.css` is opt-in, driven by `--lg-*` tokens:

```css
[data-lookglass-root] {
  --lg-accent: #6d28d9;
  --lg-radius: 10px;
  --lg-font: 'Inter', sans-serif;
}
```

Or skip the stylesheet entirely and write your own rules against the same attributes. For full control, use `useFileViewer()` and render `doc.Surface` yourself.

## Format detection

Bytes first, declared MIME second, extension last — because extensions lie constantly in production. `.xls` files that are really HTML, `.docx` that are really legacy CFB, downloads with no extension. When the bytes disagree with the claim, lookglass follows the bytes and reports the disagreement in `format.mismatch` so the UI can say so rather than silently mis-rendering.

## Adding a renderer

Every format implements the same contract, so the toolbar, search, keyboard nav and page controls work without a single per-format branch in the UI:

```ts
import { registerRenderer } from 'lookglass';

registerRenderer({
  id: 'acme/dwg',
  kinds: ['unknown'],
  load: async () => (await import('./dwg-renderer')).dwgRenderer,
});
```

A `RendererFactory.open()` returns `{ meta, controller, Surface, dispose }`. `meta.capabilities` is what the chrome reads to decide which controls to mount. See `src/renderers/text` — it is the smallest complete implementation and exercises every subsystem.

## Bundler notes

Workers are constructed as `new Worker(new URL('./x.worker.js', import.meta.url), { type: 'module' })`, which webpack 5, Turbopack and Vite all understand. Verified against a Next.js production build. If your setup rewrites worker URLs:

```ts
import { setWorkerResolver } from 'lookglass';
setWorkerResolver((name, fallback) => myWorkerFactory(name) ?? fallback());
```

The build preserves `"use client"` per-module via `preserveModules` plus a custom directive plugin. The stock `rollup-plugin-preserve-directives` does not work here: esbuild strips directives during `transform`, before that plugin looks, and the result builds cleanly but turns every client component into a server component at runtime.

## Roadmap

| | Scope | Status |
| --- | --- | --- |
| M0 | Core: sources, detection, registry, workers, memory, chrome, server, SW | ✅ Done |
| M1 | JSON, XML, Markdown, SVG; upgrade text with syntax highlighting | Next |
| M2 | PDF — range requests, virtualised pages, render cancellation | |
| M3 | CSV (streaming) + XLSX (SheetJS, vendored) | |
| M4 | DOCX | |
| M5a | PPTX tiers 1–2: zip index, slide/layout/master inheritance, theme | |
| M5b | PPTX tiers 3–5: preset geometry, text layout, autofit, tables | |
| M6 | Fuzz corpus, a11y audit, docs, v1.0 | |

## Development

```bash
npm install
npm run build          # build the package
npm test               # unit tests (vitest)
npm run fixtures -w @lookglass/example-next
npm run dev            # playground at http://localhost:3210
npm run test:e2e       # offline acceptance suite (Playwright)
```

The Playwright suite is the real acceptance test: it warms the cache, calls `context.setOffline(true)`, reloads, and opens documents. Nothing else catches a worker chunk that never got cached or an asset quietly fetched from a CDN.

## License

MIT
