import { expect, test, type Page } from '@playwright/test';

/**
 * The native Word engine, in a browser.
 *
 * Unit tests cover the layout rules; these cover what only a real browser
 * shows: pages painted from display lists, with selectable text, images
 * fetched from the package, footnotes at the foot of the page, search
 * highlighting over painted text, and the outline and links.
 */

async function open(page: Page, name: RegExp) {
  await page.goto('/?offline=0&docx=native');
  await expect(page.getByRole('heading', { name: 'lookglass' })).toBeVisible();
  await page.getByRole('button', { name }).click();
  await expect(page.locator('[data-lookglass-surface="docx"] .lg-painted .lg-text').first()).toBeAttached({ timeout: 60_000 });
}

const pageInput = (page: Page) => page.locator('[data-lookglass-page-input]');
/** Text painted on one page, in reading order. */
const pageText = async (page: Page, index: number) =>
  (await page.locator(`[data-lookglass-page-index="${index}"] .lg-text`).innerText()).replace(/\s+/g, ' ');

test.describe('docx (native engine)', () => {
  test('paints pages with real text, headers, footers and page numbers', async ({ page }) => {
    await open(page, /report\.docx/);
    await expect(page.locator('[data-lookglass-title]')).toHaveText('Annual operations report');
    await expect(page.locator('[data-lookglass-page-total]')).not.toHaveText('/ 1', { timeout: 30_000 });

    const first = await pageText(page, 1);
    expect(first).toContain('lookglass report header');
    expect(first).toContain('Confidential footer');
    expect(first).toContain('Annual operations report');

    // Text is real text, not an image: it can be selected and read.
    const selected = await page.locator('[data-lookglass-page-index="1"] .lg-text').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString().length;
    });
    expect(selected).toBeGreaterThan(100);
  });

  test('puts a footnote at the foot of the page that refers to it', async ({ page }) => {
    await open(page, /report\.docx/);
    // Find the page holding the reference rather than assuming which one it is.
    const search = page.getByRole('searchbox', { name: 'Search document' });
    await search.fill('Executive summary');
    await search.press('Enter');
    await expect(page.locator('[data-lookglass-search-status]')).toContainText('of', { timeout: 60_000 });
    const index = Number(await pageInput(page).inputValue());

    await expect.poll(() => pageText(page, index)).toContain('Footnote text for the executive summary.');
    // The note is painted at the foot of the page, well below its reference.
    const positions = await page.locator(`[data-lookglass-page-index="${index}"] .lg-text > *`).evaluateAll((nodes) => {
      const find = (text: string) => nodes.find((node) => (node.textContent ?? '').includes(text));
      const top = (node: Element | undefined) => (node ? Number.parseFloat((node as HTMLElement).style.top) : -1);
      return { reference: top(find('Executive summary')), note: top(find('Footnote text')) };
    });
    expect(positions.note).toBeGreaterThan(positions.reference + 200);
  });

  test('draws pictures from the package and never fetches linked ones', async ({ page }) => {
    const remote: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('127.0.0.1:9')) remote.push(request.url());
    });
    await open(page, /report\.docx/);
    const search = page.getByRole('searchbox', { name: 'Search document' });
    await search.fill('Logo:');
    await search.press('Enter');
    await expect(page.locator('[data-lookglass-search-status]')).toContainText('of', { timeout: 60_000 });
    const index = Number(await pageInput(page).inputValue());

    // The embedded 16x16 PNG is drawn; the externally linked one is not fetched
    // and keeps its space as a labelled box.
    const image = page.locator(`[data-lookglass-page-index="${index}"] .lg-pictures img`);
    await expect(image).toHaveCount(1);
    await expect.poll(() => image.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(16);
    // The linked picture keeps its space on the page but is never fetched.
    expect(remote).toEqual([]);
  });

  test('search finds text far into the document and highlights it', async ({ page }) => {
    await open(page, /report\.docx/);
    const search = page.getByRole('searchbox', { name: 'Search document' });
    await search.fill('needle-marker');
    await search.press('Enter');
    await expect(page.locator('[data-lookglass-search-status]')).toHaveText('1 of 1', { timeout: 60_000 });
    await expect
      .poll(() => page.evaluate(() => [...CSS.highlights.values()].reduce((sum, highlight) => sum + highlight.size, 0)), { timeout: 20_000 })
      .toBeGreaterThan(0);
  });

  test('outline entries navigate to their page', async ({ page }) => {
    await open(page, /report\.docx/);
    await expect(page.locator('[data-lookglass-page-total]')).not.toHaveText('/ 1', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Toggle outline' }).click();
    const outline = page.locator('[data-lookglass-outline]');
    await expect(outline.getByRole('button', { name: /^Chapter \d+/ })).toHaveCount(30, { timeout: 30_000 });
    await outline.getByRole('button', { name: /^Chapter 5\b/ }).click();
    await expect.poll(async () => Number(await pageInput(page).inputValue()), { timeout: 20_000 }).toBeGreaterThan(1);
    const target = Number(await pageInput(page).inputValue());
    await expect.poll(() => pageText(page, target)).toContain('Chapter 5');
  });

  test('lays out a 20,000-paragraph document without blocking the first page', async ({ page }) => {
    const started = Date.now();
    await open(page, /flow\.docx/);
    expect(Date.now() - started).toBeLessThan(30_000);
    await expect(page.locator('[data-lookglass-page-total]')).not.toHaveText('/ 1', { timeout: 60_000 });
    // Only the pages on screen are painted.
    expect(await page.locator('[data-lookglass-surface="docx"] .lg-painted').count()).toBeLessThan(6);
  });
});
