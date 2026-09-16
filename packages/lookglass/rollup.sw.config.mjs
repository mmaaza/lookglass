import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import resolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import esbuild from 'rollup-plugin-esbuild';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

/**
 * The standalone service worker is bundled separately, as a classic IIFE.
 *
 * It must not be an ES module: `type: 'module'` service workers still are not
 * supported in Firefox or Safari, and a viewer whose offline support only
 * works in Chrome is not offline support.
 *
 * The version is derived from the package version plus a content hash of the
 * built routes, so shipping a patch invalidates the cache generation without
 * anyone having to remember to bump a constant.
 */
const version = `${pkg.version}-${hashOf('src/sw/index.ts')}`;

export default {
  input: 'src/sw/standalone.ts',
  output: {
    file: 'dist/lookglass-sw.js',
    format: 'iife',
    sourcemap: false,
  },
  plugins: [
    resolve({ browser: true, extensions: ['.ts', '.js'] }),
    replace({
      preventAssignment: true,
      values: {
        __LOOKGLASS_VERSION__: JSON.stringify(version),
        // Populated by the consumer's build via the precache plugin; the
        // default is empty so the worker is valid on its own.
        __LOOKGLASS_PRECACHE__: JSON.stringify([]),
      },
    }),
    esbuild({ target: 'es2020', minify: true }),
  ],
};

function hashOf(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8);
}
