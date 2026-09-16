# lookglass — monorepo

All-in-one, offline-capable file viewer for React and Next.js.

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
