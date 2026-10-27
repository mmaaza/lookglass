# Lookglass

An open-source, offline-capable file viewer for React and Next.js. Preview documents, spreadsheets, images, code, and structured data in the browser, with workers and virtualized views to keep large files manageable.

**Status:** pre-1.0. PDF, spreadsheets, CSV, DOCX, images, text, JSON, XML, and Markdown are implemented. A native Word layout engine is available as an opt-in. **PPTX is planned and is not supported yet.**

[Package documentation](packages/lookglass/README.md) · [Report an issue](https://github.com/mmaaza/lookglass/issues) · [Contributing](#contributing) · [Roadmap](#roadmap)

## Features

| Format | Available today |
| --- | --- |
| PDF | Range loading, virtualized pages, zoom, rotation, selectable text, search, outline, links, and password prompts |
| DOCX | Virtualized pages, search, outline, bookmarks, lists, tables, headers, footers, and notes through the default `docx-preview` engine; opt-in native layout engine |
| XLSX, XLSM, XLS, XLSB, ODS | Worker-based parsing, sheet switching, virtualized grid, merged cells, cached formula values, and search within the active sheet |
| CSV / TSV | Streaming row indexing, delimiter detection, and a virtualized grid that reads visible rows on demand |
| Text / source code | Virtualized lines, search, and worker-based syntax highlighting for supported languages |
| JSON / JSON Lines / XML | Streaming offset indexes and virtualized tree views |
| Markdown | Sanitized rendering, GFM tables and task lists, heading outline, and block virtualization |
| Images / SVG | Browser image rendering, zoom, animated GIFs, and sanitized inline SVG |

Use `<FileViewer>` with its toolbar, or build your own interface with headless hooks. Sources can be a `File`, `Blob`, `ArrayBuffer`, URL, or `{ url, headers }`. Styles are optional and customizable through `--lg-*` CSS variables. Renderers load lazily, and a registry lets applications add their own formats.

### How large-file handling works

All renderers read through a shared source abstraction. PDF can request byte ranges; text, CSV, JSON, and XML build indexes and retrieve windows of content. Virtualized surfaces mount visible pages, rows, or nodes. Workers handle parsing where supported, and a byte-budgeted cache limits retained rendered data. Closing a document cancels its work and releases resources.

Memory use still depends on the format. Workbooks are read whole into a worker. The default DOCX engine reads the whole package and parses and lays it out on the main thread before virtualizing pages. Both have size limits.

## Run the playground

Requirements: Node.js **22.13 or later**, npm, and a modern browser. The example uses Next.js 15 and React 19; the library accepts React and React DOM 18.2 or 19.

```bash
git clone https://github.com/mmaaza/lookglass.git
cd lookglass
npm ci
npm run build
npm run fixtures -w @lookglass/example-next
npm run dev
```

Open [localhost:3210](http://localhost:3210). Fixture generation creates sample documents for the playground and browser tests. Rebuild the package after changing library source; the example consumes its built output.

For a production preview, stop the development server and run:

```bash
npm run build -w @lookglass/example-next
npm run start -w @lookglass/example-next
```

Use the production preview to exercise service-worker behavior. The playground disables its service worker during development.

## Use in a React application

To create an installable package from this checkout:

```bash
npm run build
npm pack -w lookglass
```

Install the generated `.tgz` in your application with `npm install <path-to-tarball>`. In that application, ensure a `public` directory exists, then copy runtime assets:

```bash
npx lookglass-copy-assets --sw
```

This copies PDF fonts and decoders and a standalone service worker. Use `--public <directory>` for a different public directory. If your application already has a service worker, integrate the `lookglass/sw` routes instead of replacing it. The included Next.js example uses `withLookglass` to copy assets during its build.

```tsx
'use client';

import { FileViewer } from 'lookglass/react';
import 'lookglass/styles.css';

export function DocumentPreview({ file }: { file: File }) {
  return <FileViewer source={file} />;
}
```

In Next.js, render the viewer from a client component. The `lookglass` root exports server-safe types, detection, and source utilities. See the [package documentation](packages/lookglass/README.md) for styling, headless hooks, remote sources, renderer options, and the Node range-serving helper.

### Offline use

Prepare the application while online: register a service worker, let it take control, and call `warmCache()` to load renderer chunks, runtime assets, and the app shell. Remote documents can be cached separately with `offline={{ cache: true }}`.

Application assets use the Cache API; document bytes use the Origin Private File System (OPFS), so cached files can still be read in slices. Document caching runs in the background by default. Wait for `onCached` before treating a document as available offline; closing it cancels an unfinished copy. Use `mode: 'before-open'` when the copy must finish first.

Service workers and OPFS require browser support and a secure context such as HTTPS or localhost. Offline availability also depends on the browser retaining cached data. See the [offline guide](packages/lookglass/README.md#offline).

### Integrating from another project (AI agents)

AI coding agents and developers adding Lookglass to another app should follow [packages/lookglass/INTEGRATION.md](packages/lookglass/INTEGRATION.md). It is also published inside the npm package as `node_modules/lookglass/INTEGRATION.md`.

## Current limits

- **PPTX:** no renderer yet. Format detection does not imply rendering support.
- **DOCX fidelity:** the default engine uses saved Word page-break markers where available and estimates pagination otherwise. It is not a pixel-identical replacement for Word. Legacy `.doc` and encrypted DOCX files are unsupported.
- **Native DOCX:** opt-in while layout accuracy and coverage develop. Enable it with `options={{ rendererOptions: { 'lookglass/docx': { engine: 'native' } } }}`.
- **Workbook size:** defaults to a 200 MiB file ceiling and 100,000 rows per sheet, with a truncation notice. Export as CSV for streaming access to larger datasets. Formulas display saved values and are not recalculated. Password-protected workbooks are unsupported.
- **Default DOCX size:** defaults to a 150 MiB file ceiling and 128 MiB of inflated XML. Initial parsing and layout can block the main thread.
- **CSV:** sorting and filtering are not implemented.
- **Printing:** PDF and DOCX printing is not offered because virtualized pages are not all mounted. Download the original to print elsewhere.
- **Browser coverage:** automated browser tests currently run Chromium; broader compatibility needs validation.

## Roadmap

The original M0–M4 milestones delivered the core, structured formats, PDF, spreadsheets, and the default DOCX renderer. The current direction replaces the earlier standalone PPTX plan with a **shared browser-based OOXML engine for DOCX and PPTX**. `docx-preview` remains the default until the native engine has sufficient coverage and accuracy.

| Work | Status and scope |
| --- | --- |
| M0–M4: initial viewer | Implemented; ongoing fixes and fidelity improvements |
| O1: shared OOXML core | Initial implementation present: ZIP/OPC, XML, themes, fonts, text measurement, display lists, and an opt-in native DOCX engine |
| O2: DOCX text and pagination | In progress; native paragraph layout and pagination exist, with corpus-based calibration |
| O3: DOCX tables | Planned milestone for improved table layout and fidelity |
| O4: drawings and default-engine transition | Planned; expand drawing support and remove the fallback only after parity |
| O5: PPTX | Planned on the shared engine |
| O6: advanced OOXML | Planned: charts, equations, tracked changes, and RTL improvements |
| Release hardening | Expand malformed-file coverage, accessibility and browser testing, performance checks, and documentation before v1.0 |

Optional metric-compatible font assets are also planned. Existing layout and table code does not mean the corresponding fidelity milestone is complete. The roadmap describes direction, not release dates.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`packages/lookglass`](packages/lookglass) | TypeScript library, build scripts, and package documentation |
| [`src/core`](packages/lookglass/src/core) | Registry, controllers, worker RPC, cancellation, and memory management |
| [`src/source`](packages/lookglass/src/source) | Local files, HTTP ranges, and OPFS caching |
| [`src/renderers`](packages/lookglass/src/renderers) / [`src/workers`](packages/lookglass/src/workers) | Format surfaces and background parsing |
| [`src/ooxml`](packages/lookglass/src/ooxml) / [`src/formats/docx`](packages/lookglass/src/formats/docx) | Shared OOXML infrastructure and native Word layout |
| [`examples/next-app`](examples/next-app) | Playground and fixture generators |
| [`packages/lookglass/test`](packages/lookglass/test) / [`e2e`](e2e) | Unit and browser acceptance tests |
| [`vendor/sheetjs`](packages/lookglass/vendor/sheetjs) | Vendored SheetJS release, license, and provenance |

## Contributing

Bug reports, documentation improvements, shareable document fixtures, accessibility fixes, and renderer contributions are welcome. For a new format or substantial architecture change, open an issue to discuss scope and how it fits the roadmap.

1. Fork the repository, clone your fork, and follow the playground setup.
2. Create a focused branch and make your change.
3. Add regression coverage for behavior changes. Prefer small generated fixtures; do not commit private documents or files you cannot redistribute.
4. Run the relevant checks below and review your diff.
5. Open a pull request explaining the problem, resulting behavior, tests run, and remaining limitations. Include screenshots for visible changes.

### Checks

```bash
npm run typecheck
npm test
npm run build
npm run size
npm run fixtures -w @lookglass/example-next
npx playwright install chromium
npm run test:e2e
```

`npm run size` checks built bundle budgets. Playwright builds the Next.js example and serves it on port **3211**, separately from the development playground. Acceptance tests cover rendering, large files, and offline reloads. Install any OS dependencies requested by Playwright in your environment.

The optional DOCX accuracy corpus belongs in `fixtures/docx-corpus/`. It is excluded from Git, and corpus tests skip when it is absent. Passing generated-fixture tests alone does not establish Word layout parity.

### Implementation expectations

- Read through `Source` and give whole-file reads an explicit size ceiling.
- Keep expensive work in workers where practical; request visible windows rather than copying full models into React state.
- Respect cancellation, release worker leases, revoke object URLs, and dispose of cached images.
- Keep runtime assets local and test offline behavior when adding dependencies or renderer chunks.
- Sanitize document-supplied markup and styles; avoid document scripts and unintended remote resource loads.
- Preserve the server-safe root and client directives when changing exports or build tooling.
- Keep vendored SheetJS files byte-for-byte intact. Follow its [upgrade procedure](packages/lookglass/vendor/sheetjs/VENDOR.md), including provenance and checksum updates.

For bug reports, include browser and OS, format and approximate size, reproduction steps, expected and actual behavior, and a minimal shareable sample when possible.

## License

Maintainers: see the [release guide](RELEASING.md) for tarball validation and npm publication instructions.

Lookglass uses the [MIT License](LICENSE). Third-party dependencies retain their own licenses. Vendored SheetJS Community Edition 0.20.3 uses [Apache-2.0](packages/lookglass/vendor/sheetjs/LICENSE); see its [provenance](packages/lookglass/vendor/sheetjs/VENDOR.md).
