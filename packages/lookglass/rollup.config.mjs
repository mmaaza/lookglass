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
 */
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
      'renderers/image/index': 'src/renderers/image/index.ts',
      'workers/text.worker': 'src/workers/text.worker.ts',
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
];

function copyCss() {
  return {
    name: 'lookglass-copy-css',
    writeBundle() {
      mkdirSync(dirname('dist/styles.css'), { recursive: true });
      copyFileSync('src/styles.css', 'dist/styles.css');
    },
  };
}
