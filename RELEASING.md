# Releasing Lookglass

The repository root is private. The npm package is the `lookglass` workspace in `packages/lookglass`.

## Prepare and validate

Use Node.js 22.13 or later. From the repository root:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run size
npm run fixtures -w @lookglass/example-next
npx playwright install chromium
npm run test:e2e
```

Set the intended version in `packages/lookglass/package.json` and update the lockfile with `npm install --package-lock-only --ignore-scripts`. Before a subsequent release, check the published version with `npm view lookglass version`.

Create an `artifacts` directory, then pack:

```bash
npm pack -w lookglass --pack-destination artifacts
```

The `prepack` hook rebuilds JavaScript, workers, declarations, CSS, and the service worker. It typechecks the public exports in a DOM-only consumer configuration, validates package entry points and client directives, copies the repository's MIT license, and generates notices for third-party code bundled into workers. Packing fails if any of these steps fail.

The tarball includes source files for source-map navigation. It excludes tests, fixtures, example apps, and build-only tools. PDF.js is pinned because its installed main-thread library must match the prebuilt worker. Upgrade the pin and rebuild together.

Install the generated tarball in a separate app before release:

```bash
npm install /path/to/lookglass-0.1.0.tgz
npx lookglass-copy-assets --sw
```

Run the asset command from the consuming app with an existing `public` directory. Verify its production build, document rendering, and offline reload. If it already has a service worker, integrate the Lookglass routes rather than replacing it.

## Publish the validated tarball

Publishing is a separate step from preparation. Use an npm account authorized to publish the name. The first release is subject to npm name availability and account permissions.

```bash
npm login
npm publish ./artifacts/lookglass-0.1.0.tgz --access public --dry-run
npm publish ./artifacts/lookglass-0.1.0.tgz --access public
```

Replace the filename for later versions. Publishing the inspected tarball keeps the uploaded contents identical to the validated artifact. Complete npm's authentication or two-factor prompt when requested. Do not commit credentials or tokens.

After publication, verify the version and package metadata with `npm view lookglass`, test a registry install, and create a matching Git tag and GitHub release describing changes and known limitations.
