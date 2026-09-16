#!/usr/bin/env node
/**
 * Copy lookglass runtime assets into the app's public directory.
 *
 * Why this exists: Next.js cannot serve files out of `node_modules`, and
 * PDF.js needs `cmaps/` and `standard_fonts/` at runtime as real HTTP
 * requests. Without them, CJK text and any PDF without embedded fonts render
 * blank or as boxes. The usual workaround — pointing PDF.js at a CDN — is not
 * available to us, because the whole point of this package is that it works
 * offline.
 *
 * Also emits `lookglass-precache.json`, the stable-URL manifest the service
 * worker precaches at install. Renderer chunks are *not* in that manifest:
 * their URLs are produced by the host app's bundler and are only discoverable
 * at runtime, which is what `warmCache()` handles.
 *
 * Usage:
 *   npx lookglass-copy-assets [--public <dir>] [--base <url-path>] [--sw] [--quiet]
 */

import { cp, mkdir, writeFile, readdir, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
const publicDir = resolve(args.public ?? 'public');
const urlBase = (args.base ?? '/lookglass').replace(/\/+$/, '');
const targetDir = join(publicDir, urlBase.replace(/^\//, ''));
const log = args.quiet ? () => {} : (...parts) => console.log('[lookglass]', ...parts);

/** Package -> the directories inside it that must reach the browser. */
const ASSET_SOURCES = [
  { pkg: 'pdfjs-dist', dirs: ['cmaps', 'standard_fonts'], reason: 'PDF font and CJK support' },
];

async function main() {
  if (!(await exists(publicDir))) {
    console.error(`[lookglass] public directory not found: ${publicDir}`);
    console.error('            pass --public <dir> if yours is somewhere else.');
    process.exitCode = 1;
    return;
  }

  await mkdir(targetDir, { recursive: true });
  const copied = [];

  for (const { pkg, dirs, reason } of ASSET_SOURCES) {
    const root = resolvePackageDir(pkg);
    if (!root) {
      // Not an error: optional formats simply are not installed yet.
      log(`skipping ${pkg} (not installed) — needed for ${reason}`);
      continue;
    }
    for (const dir of dirs) {
      const from = join(root, dir);
      if (!(await exists(from))) {
        log(`skipping ${pkg}/${dir} (not present in this version)`);
        continue;
      }
      const to = join(targetDir, dir);
      await cp(from, to, { recursive: true });
      const files = await walk(to);
      copied.push(...files);
      log(`copied ${pkg}/${dir} -> ${relative(process.cwd(), to)} (${files.length} files)`);
    }
  }

  if (args.sw) {
    const swSource = join(here, '..', 'dist', 'lookglass-sw.js');
    if (await exists(swSource)) {
      const swTarget = join(publicDir, 'sw.js');
      await cp(swSource, swTarget);
      log(`copied service worker -> ${relative(process.cwd(), swTarget)}`);
    } else {
      log('service worker not found in dist; run the package build first');
    }
  }

  // Font files are what actually break rendering when missing, so precache
  // those and the cmaps; everything else can be fetched on demand.
  const assets = copied
    .map((file) => `${urlBase}/${relative(targetDir, file).split(sep).join('/')}`)
    .sort();

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    base: urlBase,
    assets,
  };

  await writeFile(join(targetDir, 'lookglass-precache.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`wrote precache manifest with ${assets.length} assets`);

  if (assets.length === 0) {
    log('no runtime assets yet — that is expected until the PDF renderer lands');
  }
}

function resolvePackageDir(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sw') out.sw = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--public') out.public = argv[++i];
    else if (arg === '--base') out.base = argv[++i];
  }
  return out;
}

await main();
