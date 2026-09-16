import { withLookglass } from 'lookglass/precache-plugin';

/**
 * `withLookglass` copies runtime assets into `public/` and drops the prebuilt
 * service worker at `public/sw.js`. Both are also available as a plain
 * `npx lookglass-copy-assets --sw` step if you would rather not wrap the config.
 */
export default withLookglass({
  reactStrictMode: true,
  // The package ships pre-built ESM, so no transpilePackages entry is needed.
});
