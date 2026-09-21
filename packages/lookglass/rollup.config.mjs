import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import esbuild from 'rollup-plugin-esbuild';
import { preserveDirectives } from './tools/preserve-directives.mjs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  /^react($|\/)/,
  /^react-dom($|\/)/,
  /^node:/,
];

/**
 * Two things about this config are load-bearing for Next.js App Router.
 *
 * 1. `preserveModules: true` plus `rollup-plugin-preserve-directives` keeps
 *    each source file as its own output file with its `"use client"` banner
 *    intact. esbuild/tsup strip directives and merge chunks, which produces a
 *    package whose client components are silently treated as server
 *    components — it builds, then fails at runtime on the first hook.
 *
 * 2. Worker files are emitted as separate entry points so
 *    `new Worker(new URL('./x.worker.js', import.meta.url))` still resolves to
 *    a real file after bundling, which is what webpack, Turbopack and Vite all
 *    key off to emit the worker chunk.
 *
 * 3. Workers are built separately, as fully self-contained bundles resolved
 *    with the `worker` export condition. Leaving their dependencies for the
 *    consumer's bundler to resolve is not safe: webpack applies the `browser`
 *    condition inside workers too, and some packages publish a DOM-based
 *    browser build (`decode-named-character-reference` touches `document` at
 *    import time), which crashes the worker before it can answer a single
 *    call. Bundling here makes worker behaviour independent of the host app.
 */
const WORKERS = ['text', 'json', 'xml', 'markdown', 'pdf', 'csv', 'sheet'];
export default [
  {
    input: {
      index: 'src/index.ts',
      'headless/index': 'src/headless/index.ts',
      'react/index': 'src/react/index.ts',
      'server/index': 'src/server/index.ts',
      'sw/index': 'src/sw/index.ts',
      'renderers/defaults': 'src/renderers/defaults.ts',
      'renderers/text/index': 'src/renderers/text/index.ts',
      'renderers/pdf/index': 'src/renderers/pdf/index.ts',
      'renderers/docx/index': 'src/renderers/docx/index.ts',
      'renderers/csv/index': 'src/renderers/csv/index.ts',
      'renderers/sheet/index': 'src/renderers/sheet/index.ts',
      'renderers/json/index': 'src/renderers/json/index.ts',
      'renderers/xml/index': 'src/renderers/xml/index.ts',
      'renderers/markdown/index': 'src/renderers/markdown/index.ts',
      'renderers/svg/index': 'src/renderers/svg/index.tsx',
      'renderers/image/index': 'src/renderers/image/index.ts',
    },
    external,
    output: {
      dir: 'dist',
      format: 'es',
      preserveModules: true,
      preserveModulesRoot: 'src',
      entryFileNames: '[name].js',
      chunkFileNames: '[name].js',
      sourcemap: true,
      // Directives only survive if rollup is not allowed to hoist them away.
      hoistTransitiveImports: false,
    },
    plugins: [
      resolve({ browser: true, extensions: ['.ts', '.tsx', '.js', '.mjs'] }),
      commonjs(),
      json(),
      esbuild({
        target: 'es2022',
        jsx: 'automatic',
        tsconfig: 'tsconfig.json',
        sourceMap: true,
        minify: false,
      }),
      preserveDirectives(),
      copyCss(),
    ],
    onwarn(warning, warn) {
      // Expected: every `"use client"` file trips this, and preserving them is
      // the entire point of the plugin above.
      if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
      warn(warning);
    },
  },
  ...WORKERS.map((name) => ({
    input: { [`${name}.worker`]: `src/workers/${name}.worker.ts` },
    output: {
      dir: 'dist/workers',
      format: 'es',
      sourcemap: true,
      entryFileNames: '[name].js',
      // Dynamic imports inside a worker (syntax grammars) stay as separate
      // chunks, so opening a Python file never downloads the Rust grammar.
      chunkFileNames: `chunks/${name}-[name]-[hash].js`,
    },
    plugins: [
      name === 'pdf' ? disablePdfjsAutoStart() : undefined,
      resolve({
        browser: false,
        exportConditions: ['worker', 'import', 'module', 'default'],
        extensions: ['.ts', '.js', '.mjs'],
      }),
      commonjs(),
      json(),
      esbuild({ target: 'es2022', tsconfig: 'tsconfig.json', sourceMap: true, minify: false }),
    ],
  })),
];

/**
 * Remove PDF.js's self-starting worker block.
 *
 * It is guarded by an environment check on `typeof window`, which Next.js
 * rewrites in client bundles, so whether it runs depends on the host bundler.
 * `src/workers/pdf.worker.ts` starts the handler explicitly instead. The
 * build fails if the pattern is not found, so a PDF.js upgrade that changes
 * this code cannot silently reintroduce a double start or no start at all.
 */
function disablePdfjsAutoStart() {
  const guard =
    /"undefined"==typeof window&&![\w$]+&&"undefined"!=typeof self&&"function"==typeof self\.postMessage&&"onmessage"in self/g;
  return {
    name: 'lookglass-disable-pdfjs-autostart',
    transform(code, id) {
      if (!/pdfjs-dist[\\/]build[\\/]pdf\.worker\.min\.mjs$/.test(id)) return null;
      const matches = code.match(guard)?.length ?? 0;
      if (matches !== 1) {
        this.error(
          `Expected exactly one PDF.js worker auto-start guard, found ${matches}. Re-check pdf.worker.ts against this pdfjs-dist version.`,
        );
      }
      return { code: code.replace(guard, 'false'), map: null };
    },
  };
}

function copyCss() {
  return {
    name: 'lookglass-copy-css',
    writeBundle() {
      mkdirSync(dirname('dist/styles.css'), { recursive: true });
      copyFileSync('src/styles.css', 'dist/styles.css');
    },
  };
}
