import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Accuracy benchmark over real documents in `fixtures/docx-corpus/`.
 *
 * The corpus is supplied locally and never committed (it is in .gitignore),
 * so this suite skips when the folder is absent. For each file it records
 * how long opening takes and how many pages were produced, and screenshots a
 * spread of pages into test-results/corpus for side-by-side comparison with
 * Word. Word's own page count comes from docProps/app.xml; matching it is
 * the first accuracy target.
 */

const CORPUS = 'fixtures/docx-corpus';
const files = existsSync(CORPUS) ? readdirSync(CORPUS).filter((name) => name.toLowerCase().endsWith('.docx')) : [];

test.describe('docx corpus', () => {
  test.skip(files.length === 0, 'no documents in fixtures/docx-corpus');

  for (const file of files) {
    test(file, async ({ page }, info) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 1400, height: 1100 });
      await page.goto('/?offline=0');
      const started = Date.now();
      await page.locator('input[type=file]').setInputFiles(join(CORPUS, file));
      await expect(page.locator('[data-lookglass-surface="docx"] section').first()).toBeVisible({ timeout: 150_000 });
      const pages = (await page.locator('[data-lookglass-page-total]').innerText()).replace(/[^\d]/g, '');
      info.annotations.push({ type: 'result', description: `${file}: ${pages} pages, opened in ${Date.now() - started} ms` });

      await page.getByRole('combobox', { name: 'Fit mode' }).selectOption('page');
      const slug = file.replace(/\W+/g, '_');
      for (const n of [1, 2, 3, 5, 8, 12, 20, 30, 50]) {
        if (n > Number(pages)) break;
        await page.locator('[data-lookglass-page-input]').fill(String(n));
        await page.locator('[data-lookglass-page-input]').press('Enter');
        await page.waitForTimeout(500);
        await page.locator('[data-lookglass-surface="docx"]').screenshot({ path: join('test-results', 'corpus', `${slug}_p${n}.png`) });
      }
    });
  }
});
