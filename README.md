# Lookglass: Open-Source Offline File Viewer for React and Next.js

Lookglass is an open-source, offline-capable file viewer for React and Next.js. It previews PDF, DOCX, XLSX, CSV, PPTX, images, text, JSON, XML, and Markdown files with range-aware loading and offline caching.

- [`packages/lookglass`](packages/lookglass) — the published package ([docs](packages/lookglass/README.md))
- [`examples/next-app`](examples/next-app) — offline playground, also the Playwright target
- [`e2e`](e2e) — offline acceptance suite

```bash
npm install
npm run build
npm test
npm run fixtures -w @lookglass/example-next && npm run dev   # http://localhost:3210
npm run test:e2e
```
