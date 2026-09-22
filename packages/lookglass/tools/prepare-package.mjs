import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const read = (path) => readFileSync(join(root, path), 'utf8');

// npm does not inherit the monorepo's license into a workspace tarball.
copyFileSync(join(root, '../../LICENSE'), join(root, 'LICENSE'));

function checkTargets(value) {
  if (typeof value === 'string') {
    assert(existsSync(join(root, value)), `Missing package entry: ${value}`);
  } else {
    for (const target of Object.values(value)) checkTargets(target);
  }
}
checkTargets(pkg.exports);
checkTargets(pkg.bin);
checkTargets({ main: pkg.main, module: pkg.module, types: pkg.types });
assert(!read('dist/index.js').includes("'use client'"), 'Package root must remain server-safe');
for (const entry of ['react', 'headless']) {
  assert(/^['"]use client['"];/.test(read(`dist/${entry}/index.js`)), `Missing client directive: ${entry}`);
}
for (const worker of ['text', 'json', 'xml', 'markdown', 'pdf', 'csv', 'sheet', 'docx']) {
  assert(existsSync(join(root, `dist/workers/${worker}.worker.js`)), `Missing ${worker} worker`);
}
assert(existsSync(join(root, 'dist/lookglass-sw.js')), 'Missing standalone service worker');

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

// Workers contain bundled third-party code. Collect its actual license texts
// from the build's source maps, including lazily loaded grammar chunks.
const dependencies = new Map();
for (const path of walk(join(root, 'dist'))) {
  if (!path.endsWith('.js.map')) continue;
  const map = JSON.parse(readFileSync(path, 'utf8'));
  for (const source of map.sources) {
    if (!source.replaceAll('\\', '/').includes('node_modules/')) continue;
    let directory = dirname(resolve(dirname(path), map.sourceRoot ?? '', source));
    let dependency;
    while (true) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest)) {
        dependency = JSON.parse(readFileSync(manifest, 'utf8'));
        if (dependency.name && dependency.version) break;
      }
      const parent = dirname(directory);
      assert(parent !== directory, `Cannot locate bundled dependency: ${source}`);
      directory = parent;
    }
    dependencies.set(`${dependency.name}@${dependency.version}`, { directory, dependency });
  }
}
assert(dependencies.size > 0, 'No bundled dependency source maps found');
const notices = [
  '# Third-party notices',
  'Generated during packaging from dependencies included in the built JavaScript. External npm dependencies carry their own license files. Vendored SheetJS notices are in vendor/sheetjs/LICENSE and vendor/sheetjs/VENDOR.md.',
];
for (const [name, { directory, dependency }] of [...dependencies].sort(([a], [b]) => a.localeCompare(b))) {
  const licenses = readdirSync(directory).filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  assert(licenses.length > 0, `Missing license text for bundled dependency ${name}`);
  notices.push(`## ${name}\n\nLicense: ${dependency.license ?? 'See text below'}`);
  for (const license of licenses.sort()) {
    notices.push(`### ${license}\n\n${readFileSync(join(directory, license), 'utf8').trim()}`);
  }
}
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), `${notices.join('\n\n')}\n`);
console.error(`Validated exports, workers, client directives, and notices for ${dependencies.size} bundled dependencies.`);
