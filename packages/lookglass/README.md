# lookglass

Open-source, offline-capable file viewer for React and Next.js — built for files that are too big for the naive approach.

> **Status: M4.** PDF, Word (DOCX), spreadsheets (XLSX, XLS, XLSB, ODS), CSV/TSV, text, source code, images, SVG, JSON, JSON Lines, XML and Markdown are supported. PPTX lands in M5 — see [Roadmap](#roadmap).

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
// Opens immediately over HTTP ranges; the file is copied to OPFS in the
// background, and later opens work with no network.
<FileViewer
  source={{ url: '/api/files/report.pdf' }}
  offline={{ cache: true, onCached: () => markAvailableOffline() }}
/>
```

Caching runs **in the background by default**. Copying the whole file before opening it would mean a 1 GB PDF downloads completely before page 1 appears — the exact cost range loading exists to avoid. Pass `mode: 'before-open'` if you need the offline copy guaranteed before anything is shown. A background copy is cancelled when the document is closed, and a partial copy is discarded rather than served.

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

## Formats

| Format | How it scales | Notes |
| --- | --- | --- |
| Text / logs | Worker builds a newline offset index; lines decoded per visible window | Tested to 40k+ lines with under 200 DOM rows |
| Source code | Same as text, plus Shiki highlighting in the worker, 512 lines at a time | 44 languages, files up to 2 MB; larger files stay plain |
| JSON, JSON Lines | Streaming byte scanner builds an offset table — **no `JSON.parse`** | ~30 bytes of index per node, values decoded per row |
| XML | Same offset table as JSON, from a streaming scanner | Entities are never expanded (see below) |
| Markdown | Parsed and sanitised in a worker, emitted per block, block-virtualised | GFM tables, task lists, raw HTML (sanitised). 32 MB cap |
| SVG | Sanitised with DOMPurify, rendered inline | Scripts, handlers, `foreignObject` and remote references removed |
| PDF | PDF.js in a per-document worker, fed byte ranges from the source; virtualised pages | Search, text selection, outline, links, rotation, passwords. CJK via bundled CMaps |
| DOCX | docx-preview renders once; pages are kept detached and mounted only while visible, in a shadow root | Word's own page breaks, headers, footers, footnotes, lists, tables, images, outline, TOC links. Documents with no page breaks are cut into page-sized pieces. 150 MB / 128 MB of XML by default |
| CSV, TSV | Worker indexes every row's byte offset in one streaming pass; tiles read only the rows on screen | Quoted newlines, CRLF, UTF-16 (Excel "Unicode text"), delimiter and header detection. No size limit beyond 20 M rows |
| XLSX, XLSM, XLSB, XLS, ODS | Vendored SheetJS in a worker; sheets listed without parsing, each parsed on first view | Merged cells, column widths, hidden columns and sheets, number formats, formula bar. 200 MB / 100k rows per sheet by default |
| PNG, JPEG, WebP, GIF, AVIF | `createImageBitmap`, downscaled past the Safari canvas limit | EXIF orientation honoured; GIFs stay animated |

### Why JSON is never `JSON.parse`d

`JSON.parse` on a 300 MB document allocates an object graph several times the file size and blocks the thread for tens of seconds before it succeeds or throws. lookglass instead scans the bytes once into parallel typed arrays of offsets — every structural character in JSON is ASCII, and UTF-8 continuation bytes always have the high bit set, so a byte-level state machine finds every token without decoding anything. Keys and values are decoded only for the rows on screen, and each read is clamped, so a single 50 MB string costs the same to display as a short one.

The scanner is verified by round-tripping every test document back through the offset table and comparing against `JSON.parse`, including values that straddle the 1 MiB chunk boundary.

### PDF

Every read goes through the same `Source` as every other format, via a PDF.js range transport, with PDF.js's own background fetching turned off. A local `File`, an HTTP URL and an OPFS copy all load the same way, and only the byte ranges the visible pages need are read: in the test suite, reaching page 1,150 of an 11 MB, 1,200-page document downloads under 15% of the file.

Pages are rasterised to `ImageBitmap`s held in the shared byte budget, two at a time, with rendering cancelled for pages scrolled past. Zooming shows the nearest cached scale stretched until the sharp render lands, instead of blank pages. The text layer (selection and search highlighting) is added only once a page has settled.

Passwords: `<FileViewer>` shows a prompt and handles wrong passwords and cancellation. With the headless hook, read `passwordPrompt` from `useFileViewer()`, or pass your own `options.requestPassword`.

Safety: documents never run embedded JavaScript (the QuickJS sandbox is not shipped), XFA forms are off, and only `http`, `https` and `mailto` links are followed.

Print is deliberately not offered: most pages of a virtualised document are unmounted, so browser print would produce blank sheets. Download the original instead.

### Word documents

Rendering uses [docx-preview](https://github.com/VolodymyrBaydalka/docxjs), which needs the DOM, so parsing and layout run on the main thread; the package's inflated XML is checked from the ZIP directory before anything is parsed, so a small file that expands to gigabytes is refused instead of freezing the tab. After that, everything is built for size: docx-preview's page sections are kept **detached**, and only the pages on screen are moved into the document. In the test suite a 100,000-paragraph document (18.7 MB of XML, 2,500 pages) opens in under 4 seconds with a handful of pages mounted; search builds its text index on first use (about 350 ms there) and is instant after that.

Pages follow Word's own pagination: Word records where it broke pages when it saves a file, and those markers are used. Files written by other tools often carry no page breaks at all, and would render as one enormous page; those are cut into page-sized pieces at paragraph boundaries, and between table rows (never inside a merged cell). `meta.extra.pagination` says which happened — `'word'` or `'estimated'`.

Two things break when pages are detached, and both are repaired. **List numbering** is CSS counters, which only count elements in the live DOM, so each page is given the counter values the whole document would have reached by then. **Internal links** (tables of contents, bookmarks) point at pages that may not be mounted, so they are resolved against an index and navigated in the virtual list.

Safety: docx-preview pastes style and font names from the file into its stylesheet without escaping, so a crafted font name can inject CSS. The stylesheet is re-parsed by the browser's CSS parser in an inert document and rebuilt rule by rule, dropping `@import`, `:host`, and any declaration that loads a remote resource; it is then applied inside a **shadow root**, so it cannot style the host app even if something slipped through (and the host app's CSS cannot distort the document). Markup goes through DOMPurify: `javascript:` links are removed, external links open in a new tab, remote images are never fetched, and embedded HTML chunks (which docx-preview would render as unsandboxed iframes) are not rendered. Comments are not shown; tracked changes are shown as final text unless `trackedChanges: true`.

Office fonts that exist only on Windows get metric-compatible fallbacks (Carlito for Calibri, Caladea for Cambria, the Liberation family for Arial, Times New Roman and Courier New), so text wraps where Word wraps it when those fonts are installed. Style pages from outside with `[data-lookglass-surface="docx"]::part(page)`.

Password-protected `.docx` files and Word 97-2003 `.doc` files are recognised from their container and reported with a clear message; neither can be opened in the browser. Print is not offered, for the same reason as PDF.

```tsx
<FileViewer source={file} options={{ rendererOptions: { 'lookglass/docx': { maxBytes: 300 * 1024 * 1024, trackedChanges: true } } }} />
```

### Spreadsheets

CSV and workbooks share one grid: virtualised in both directions, with the column headers and row numbers as `sticky` elements in the same scroll container, so they move with the cells natively instead of being synchronised in JavaScript. Cells arrive in 128 × 32 tiles held in the shared byte budget.

**CSV** is indexed, never loaded. A streaming state machine records each row's byte offset (4 bytes per row), and a tile reads exactly its rows back from the file — a 12 MB, 400,000-row export opens with a few hundred cells in the DOM. Quotes open a field only at field start, so a stray `5" floppy` does not swallow the rest of the file as one row. UTF-16 input is scanned in two-byte units, because a byte scan finds `0x0A` inside unrelated characters. Sorting and filtering are deliberately absent: both need every row materialised, which is exactly what this design avoids.

**Workbooks** are compressed containers with shared-string tables, so they cannot be range-read: the file is read whole, up to 200 MB. What *is* lazy is parsing. Opening lists the sheets; each sheet is parsed the first time it is shown, and only two parsed sheets are kept. Parsed cells cost roughly 100 bytes each, so sheets are cut at 100,000 rows by default with a visible notice — export the sheet as CSV to see every row. Both limits are options:

```tsx
<FileViewer source={file} options={{ rendererOptions: { 'lookglass/sheet': { maxRows: 250_000 } } }} />
```

**Formulas are never evaluated.** Cells show the value Excel cached when the file was saved — what the author saw — and the formula bar shows the formula. Nothing in a document can make the viewer compute anything. Search covers the sheet on screen; searching every sheet would force parsing them all.

Also handled: `.xls` files that are really HTML tables or Excel 2003 XML (what most web "Export to Excel" buttons produce), legacy `.xls` in non-Western codepages, and hidden sheets (shown, and marked). Password-protected workbooks are reported as such: SheetJS Community Edition cannot decrypt them.

SheetJS is **vendored** at `vendor/sheetjs/` (0.20.3, Apache-2.0). SheetJS no longer publishes to npm — the `xlsx` package there is years behind — and depending on a CDN tarball URL breaks air-gapped installs. See `vendor/sheetjs/VENDOR.md` for provenance, checksums and the upgrade procedure.

### Syntax highlighting

Highlighting runs inside the text worker using Shiki's JavaScript regex engine — not the Oniguruma WASM build, which would be another runtime asset to lose offline and is blocked by strict CSPs without `wasm-unsafe-eval`.

Lines are tokenised in blocks of 512, and the grammar state is carried from each block into the next. Without that, a block comment or template string that crosses a block edge is coloured as code on the far side. Carrying state means blocks must be tokenised in order, so scrolling straight to the end of a file walks forward through it once; that is why highlighting stops at 2 MB.

Cost: the first source file loads about 90 kB (brotli) of highlighter and grammar, lazily, in the worker. `warmCache()` fetches all 44 grammars — about 330 kB — so source files are coloured offline; pass `{ highlighting: false }` to skip that. Pass `rendererOptions: { 'lookglass/text': { highlight: false } }` to never load the highlighter at all.

### XML security

Entities are **never expanded**. External entities are never fetched, so XXE is impossible by construction rather than filtered. Documents that declare internal entities are flagged and their references render literally, which makes billion-laughs expansion impossible too. Only the five predefined entities and numeric character references are decoded, at display time, on already-clipped text.

### Untrusted markup

SVG and Markdown both put document-supplied markup into your page's DOM, so both are sanitised before it gets there. SVG goes through DOMPurify's SVG profile plus a hook that strips remote `href`s and `url()` references, so an image cannot phone home or render differently offline. Markdown runs `rehype-raw` *then* `rehype-sanitize` in a worker — in that order, because sanitising before parsing raw HTML lets `<img onerror>` through as text that the browser later re-parses as markup. The user is told when anything was removed.

## Format detection

Bytes first, declared MIME second, extension last — because extensions lie constantly in production. `.xls` files that are really HTML, `.docx` that are really legacy CFB, downloads with no extension. Compound (CFB) files are told apart by the names of their streams, so a password-protected `.docx`, a Word 97 file misnamed `.docx` and a workbook misnamed `.doc` are each identified correctly (`format.encrypted` marks the first). When the bytes disagree with the claim, lookglass follows the bytes and reports the disagreement in `format.mismatch` so the UI can say so rather than silently mis-rendering.

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

**PDF.js under Next.js.** PDF.js starts its worker from a static block guarded by `typeof window === "undefined"`. Next.js compiles client code — worker chunks included — with `typeof window` replaced by `"object"`, so the guard becomes `false`, the minifier deletes the start-up code, and the document hangs forever with no error. lookglass's build strips that guarded block from its bundled PDF.js worker and starts the handler explicitly, so it behaves the same under any bundler. (The build fails loudly if a PDF.js upgrade changes the code being stripped.) It also waits for the worker's `ready` message before handing it to PDF.js, because messages posted while a 1 MB module worker is still evaluating are lost.

The build preserves `"use client"` per-module via `preserveModules` plus a custom directive plugin. The stock `rollup-plugin-preserve-directives` does not work here: esbuild strips directives during `transform`, before that plugin looks, and the result builds cleanly but turns every client component into a server component at runtime.

## Roadmap

| | Scope | Status |
| --- | --- | --- |
| M0 | Core: sources, detection, registry, workers, memory, chrome, server, SW | ✅ Done |
| M1 | JSON, JSON Lines, XML, Markdown, SVG; syntax highlighting for text | ✅ Done |
| M2 | PDF — range requests, virtualised pages, render cancellation, search, outline, passwords | ✅ Done |
| M3 | CSV (streaming) + XLSX/XLS/ODS (SheetJS, vendored) | ✅ Done |
| M4 | DOCX — detached-page virtualisation, Word pagination, lists, outline, links, sanitised CSS in a shadow root | ✅ Done |
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
npm run test:e2e       # acceptance suite (Playwright), on its own port 3211
```

The Playwright suite is the real acceptance test: it warms the cache, calls `context.setOffline(true)`, reloads, and opens documents. Nothing else catches a worker chunk that never got cached or an asset quietly fetched from a CDN.

## License

MIT
