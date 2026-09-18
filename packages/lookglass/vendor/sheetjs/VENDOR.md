# SheetJS Community Edition — vendored

| | |
| --- | --- |
| Version | **0.20.3** |
| Licence | Apache-2.0 (see `LICENSE`) |
| Source | https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz |
| Tarball SHA-256 | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` |
| Vendored | 2026-09-18 |

## Why it is vendored

SheetJS stopped publishing to the npm registry after 0.18.5. The `xlsx`
package on npm is years behind, and current releases are only distributed from
`cdn.sheetjs.com`. Depending on a CDN tarball URL breaks installs in
air-gapped and private-registry environments — the environments an offline
viewer is built for — so the release is copied here and bundled into the
spreadsheet worker at build time. Consumers install nothing extra.

## Files

| File | From tarball | SHA-256 | Modified |
| --- | --- | --- | --- |
| `xlsx.mjs` | `package/xlsx.mjs` | `1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db` | No |
| `cpexcel.full.mjs` | `package/dist/cpexcel.full.mjs` | `7a7bba23b6b6f23b5c69fbb631f78d1d455f74b57e4aa54e9a2f81a8ab844964` | No |
| `xlsx.d.ts` | `package/types/index.d.ts` | `191e4e6aceae3602aa3a1e9a6bc0e98821d6d5fb787e2bc16e250439482bddb6` | No |
| `LICENSE` | `package/LICENSE` | `4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64` | No |
| `cpexcel.full.d.mts` | — | — | Written for lookglass |
| `xlsx.d.mts` | — | — | Written for lookglass (re-exports `xlsx.d.ts`) |

`cpexcel.full.mjs` holds the codepage tables. Legacy `.xls` files written in
non-Western encodings (Shift-JIS, GBK, Big5, Cyrillic, ...) decode as garbage
without it. It is only loaded by the spreadsheet worker.

Library files are copied byte-for-byte. Do not edit them: patches belong in
lookglass code, so an upgrade is a plain file replacement.

## Upgrading

1. Check the current version at https://cdn.sheetjs.com/.
2. Download `https://cdn.sheetjs.com/xlsx-<version>/xlsx-<version>.tgz` and
   record its SHA-256.
3. Replace the four library files above from the tarball.
4. Update this file's version, source, checksums and date.
5. Run `npm test` and `npm run test:e2e`; the spreadsheet fixtures cover
   XLSX, XLS, dates, formulas, merged cells and large sheets.
