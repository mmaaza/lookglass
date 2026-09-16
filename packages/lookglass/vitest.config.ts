import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom gives us Blob, File, TextDecoder, ReadableStream and
    // ResizeObserver — enough to exercise the source and detection layers
    // without a real browser. Rendering is covered by the Playwright suite.
    environment: 'happy-dom',
    globals: true,
    include: ['test/**/*.test.ts'],
  },
});
