import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Accuracy benchmark over real documents in `fixtures/docx-corpus/`.
 *
 * The corpus is supplied locally and never committed (it is in .gitignore),
 * so this suite skips when the folder is absent.
 *
 * Ground truth comes from the documents themselves. A table of contents
 * stores the page number Word computed for every heading, so comparing those
 * numbers with the pages the native engine puts the headings on measures
 * pagination accuracy without needing Word. Each run prints, per document:
 * the page count, and how many TOC entries land on Word's page. Screenshots
 * of a spread of pages go to test-results/corpus for visual comparison.
 */

const CORPUS = 'fixtures/docx-corpus';
const files = existsSync(CORPUS) ? readdirSync(CORPUS).filter((name) => name.toLowerCase().endsWith('.docx')) : [];

interface Diagnostics {
  ours: string[];
  toc: Array<{ title: string; word: string; ours?: string }>;
}

test.describe('docx corpus', () => {
  test.skip(files.length === 0, 'no documents in fixtures/docx-corpus');

  for (const file of files) {
    test(file, async ({ page }, info) => {
      test.setTimeout(180_000);
      let report: Diagnostics | undefined;
      page.on('console', (message) => {
        const text = message.text();
        if (text.startsWith('[lookglass] pagination ')) report = JSON.parse(text.slice('[lookglass] pagination '.length)) as Diagnostics;
      });
      await page.addInitScript(() => ((globalThis as { __LOOKGLASS_DEBUG__?: boolean }).__LOOKGLASS_DEBUG__ = true));
      await page.setViewportSize({ width: 1400, height: 1100 });
      await page.goto('/?offline=0&docx=native');
      const started = Date.now();
      await page.locator('input[type=file]').setInputFiles(join(CORPUS, file));
      await expect(page.locator('[data-lookglass-surface="docx"] .lg-painted .lg-text').first()).toBeAttached({ timeout: 150_000 });
      const firstPage = Date.now() - started;
      await expect.poll(() => report !== undefined, { timeout: 150_000 }).toBe(true);

      const toc = report!.toc;
      const exact = toc.filter((entry) => entry.word === entry.ours).length;
      const summary = `${file}: ${report!.ours.length} pages, first page in ${firstPage} ms, TOC page numbers matching Word: ${exact}/${toc.length}`;
      info.annotations.push({ type: 'accuracy', description: summary });
      console.log(summary);

      await page.getByRole('combobox', { name: 'Fit mode' }).selectOption('page');
      const slug = file.replace(/\W+/g, '_');
      for (const n of [1, 2, 3, 5, 8, 12, 20, 30, 50]) {
        if (n > report!.ours.length) break;
        await page.locator('[data-lookglass-page-input]').fill(String(n));
        await page.locator('[data-lookglass-page-input]').press('Enter');
        await page.waitForTimeout(500);
        await page.locator('[data-lookglass-surface="docx"]').screenshot({ path: join('test-results', 'corpus', `${slug}_p${n}.png`) });
      }
    });
  }
});
