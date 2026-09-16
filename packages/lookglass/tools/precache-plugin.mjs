/**
 * Next.js config wrapper for lookglass.
 *
 * Wrapping is optional — you can run `npx lookglass-copy-assets` in your
 * build script instead. This just makes the asset copy automatic so a fresh
 * clone cannot forget it and ship a viewer with no PDF fonts.
 *
 *   // next.config.mjs
 *   import { withLookglass } from 'lookglass/precache-plugin';
 *   export default withLookglass({ reactStrictMode: true });
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** Guards against Next invoking the webpack hook more than once per build. */
let ran = false;

export function withLookglass(nextConfig = {}, options = {}) {
  const { publicDir = 'public', assetBase = '/lookglass', copyServiceWorker = true, quiet = false } = options;

  return {
    ...nextConfig,

    webpack(config, context) {
      if (!ran && context.isServer) {
        ran = true;
        copyAssets({ publicDir, assetBase, copyServiceWorker, quiet });
      }

      // Worker files are emitted as real assets by webpack 5's own
      // `new Worker(new URL(...))` handling. The only thing that breaks it is
      // an aggressive `resolve.alias` on the package, so leave a breadcrumb
      // rather than silently producing a viewer with no workers.
      config.module = config.module ?? {};

      return typeof nextConfig.webpack === 'function' ? nextConfig.webpack(config, context) : config;
    },
  };
}

function copyAssets({ publicDir, assetBase, copyServiceWorker, quiet }) {
  let script;
  try {
    script = join(dirname(require.resolve('lookglass/package.json')), 'bin', 'copy-assets.mjs');
  } catch {
    if (!quiet) console.warn('[lookglass] could not locate the package; skipping asset copy');
    return;
  }

  const args = [script, '--public', publicDir, '--base', assetBase];
  if (copyServiceWorker) args.push('--sw');
  if (quiet) args.push('--quiet');

  const result = spawnSync(process.execPath, args, { stdio: quiet ? 'ignore' : 'inherit' });
  if (result.status !== 0 && !quiet) {
    // A failed copy must not fail the build: the app still works online, and
    // a hard failure here is a bad trade during local development.
    console.warn('[lookglass] asset copy failed; offline PDF fonts may be missing');
  }
}

export default withLookglass;
