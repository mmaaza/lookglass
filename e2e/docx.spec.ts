import { expect, test, type Page } from '@playwright/test';

/**
 * Word acceptance tests.
 *
 * What only a browser proves: pages mount and unmount as the user scrolls,
 * the shadow root keeps a hostile document's CSS off the host page, nothing
 * is fetched from the network on the document's behalf, list numbering
 * survives virtualisation, and search highlights land on the right text.
 */

async function openFile(page: Page, name: RegExp) {
  await page.goto('/?offline=0');
  await expect(page.getByRole('heading', { name: 'lookglass' })).toBeVisible();
  await page.getByRole('button', { name }).click();
}

async function openDocx(page: Page, name: RegExp) {
  await openFile(page, name);
  await expect(page.locator('[data-lookglass-surface="docx"] section').first()).toBeVisible({ timeout: 60_000 });
}

const pageInput = (page: Page) => page.locator('[data-lookglass-page-input]');
const mountedPages = (page: Page) => page.locator('[data-lookglass-surface="docx"] [data-lookglass-page-index]');
/** Playwright's CSS locators pierce open shadow roots. */
const inDoc = (page: Page, selector: string) => page.locator(`[data-lookglass-surface="docx"] ${selector}`);

test.describe('docx', () => {
  test('opens a 301-page report with Word pagination and a small DOM', async ({ page }) => {
    await openDocx(page, /report\.docx/);
    await expect(page.locator('[data-lookglass-title]')).toHaveText('Annual operations report');
    await expect(page.locator('[data-lookglass-page-total]')).toHaveText('/ 301');
    await expect(inDoc(page, 'header').first()).toContainText('lookglass report header');
    await expect(inDoc(page, 'footer').first()).toContainText('Confidential footer');

    // The embedded image loads from a blob URL.
    const logo = inDoc(page, 'img[src^="blob:"]');
    await expect(logo).toHaveCount(1);
    await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(16);

    // Three hundred pages, a handful mounted.
    expect(await mountedPages(page).count()).toBeLessThan(8);
    await page.locator('[data-lookglass-surface="docx"]').evaluate((el) => el.scrollBy(0, 60_000));
    await expect.poll(async () => Number(await pageInput(page).inputValue())).toBeGreaterThan(40);
    expect(await mountedPages(page).count()).toBeLessThan(8);
  });

  test('contains hostile content: no script links, no remote loads, no escape from the shadow root', async ({ page }) => {
    const remote: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('127.0.0.1:9')) remote.push(request.url());
    });
    await page.addInitScript(() => {
      window.addEventListener('message', (event) => {
        if (event.data === 'altchunk-ran') (window as unknown as { altChunkRan: boolean }).altChunkRan = true;
      });
    });
    await openDocx(page, /report\.docx/);
    await expect(inDoc(page, 'a', ).filter({ hasText: 'safe external link' })).toHaveAttribute('target', '_blank');

    // The javascript: link is inert.
    const scriptLink = inDoc(page, 'a').filter({ hasText: 'script link' });
    await expect(scriptLink).toHaveCount(1);
    expect(await scriptLink.getAttribute('href')).toBeNull();

    // The injected `:host { position: fixed }` rule never applies.
    const host = page.locator('[data-lookglass-docx-host]');
    expect(await host.evaluate((el) => getComputedStyle(el).position)).toBe('relative');
    expect(await host.evaluate((el) => el.shadowRoot!.querySelector('style')!.textContent)).not.toContain('127.0.0.1');

    // The embedded HTML chunk is not rendered, so its script never runs.
    expect(await inDoc(page, 'iframe').count()).toBe(0);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { altChunkRan?: boolean }).altChunkRan)).toBeUndefined();
    expect(remote).toEqual([]);
  });

  test('table-of-contents links and the outline navigate', async ({ page }) => {
    await openDocx(page, /report\.docx/);
    await inDoc(page, 'a').filter({ hasText: 'Chapter 12 (toc)' }).click();
    await expect(pageInput(page)).toHaveValue('112', { timeout: 20_000 });
    await expect(inDoc(page, 'p').filter({ hasText: /^Chapter 12$/ })).toBeInViewport();

    await page.getByRole('button', { name: 'Toggle outline' }).click();
    const outline = page.locator('[data-lookglass-outline]');
    await expect(outline.getByRole('button', { name: /^Chapter \d+/ })).toHaveCount(30);
    await outline.getByRole('button', { name: /^Chapter 20\b/ }).click();
    // Page 1 is the title page, so chapter N starts on page 2 + (N - 1) * 10.
    await expect(pageInput(page)).toHaveValue('192', { timeout: 20_000 });
    await expect(inDoc(page, 'p').filter({ hasText: /^Chapter 20$/ })).toBeInViewport();
  });

  test('list numbering continues across pages that were never mounted together', async ({ page }) => {
    await openDocx(page, /report\.docx/);
    await pageInput(page).fill('19');
    await pageInput(page).press('Enter');
    // Page 19 holds requirements 106-120: its counter starts at 105.
    const section = page.locator('[data-lookglass-page-index="19"] section');
    await expect(section).toBeAttached({ timeout: 20_000 });
    expect(await section.evaluate((el) => el.style.counterReset)).toMatch(/-num-1-0 105\b/);
    await expect(section.locator('p').filter({ hasText: 'Requirement 106' })).toBeVisible();
  });

  test('search finds text near the end and highlights it', async ({ page }) => {
    await openDocx(page, /report\.docx/);
    const search = page.getByRole('searchbox', { name: 'Search document' });
    await search.fill('needle-marker');
    await search.press('Enter');
    await expect(page.locator('[data-lookglass-search-status]')).toHaveText('1 of 1', { timeout: 30_000 });
    await expect(pageInput(page)).toHaveValue('300');
    await expect(inDoc(page, 'p').filter({ hasText: 'needle-marker' })).toBeInViewport({ timeout: 10_000 });
    await expect
      .poll(() => page.evaluate(() => [...CSS.highlights.values()].reduce((sum, highlight) => sum + highlight.size, 0)))
      .toBe(1);
  });

  test('zoom scales pages', async ({ page }) => {
    await openDocx(page, /report\.docx/);
    const first = page.locator('[data-lookglass-page-index="1"] section');
    const level = page.locator('[data-lookglass-zoom-level]');
    // US Letter is 816 CSS pixels wide at 100%.
    const widthAt = async () => 816 * (Number((await level.innerText()).replace('%', '')) / 100);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(level).toHaveText('150%');
    await expect.poll(async () => Math.abs((await first.boundingBox())!.width - (await widthAt()))).toBeLessThan(2);
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(level).toHaveText('75%');
    await expect.poll(async () => Math.abs((await first.boundingBox())!.width - (await widthAt()))).toBeLessThan(2);
  });

  test('splits a document with no page breaks into pages and keeps it fast', async ({ page }) => {
    await openDocx(page, /flow\.docx/);
    await expect(page.locator('[data-lookglass-title]')).toHaveText('Generated export');
    const total = Number((await page.locator('[data-lookglass-page-total]').innerText()).replace(/[^\d]/g, ''));
    expect(total).toBeGreaterThan(200);
    expect(await mountedPages(page).count()).toBeLessThan(8);

    // Search reaches the end of 20,000 paragraphs.
    const search = page.getByRole('searchbox', { name: 'Search document' });
    await search.fill('needle-marker');
    await search.press('Enter');
    await expect(page.locator('[data-lookglass-search-status]')).toHaveText('1 of 1', { timeout: 30_000 });
    await expect(inDoc(page, 'p').filter({ hasText: 'needle-marker' })).toBeInViewport({ timeout: 10_000 });

    // The 4,000-row table ends up whole, in order, on the last pages.
    await pageInput(page).fill(String(total));
    await pageInput(page).press('Enter');
    await expect(inDoc(page, 'td').filter({ hasText: /^table row 4000$/ })).toBeVisible({ timeout: 20_000 });
    expect(await mountedPages(page).count()).toBeLessThan(8);
  });

  test('explains password-protected and Word 97-2003 files', async ({ page }) => {
    await openFile(page, /locked\.docx/);
    await expect(page.locator('[data-lookglass-error-message]')).toContainText(/password protected/i, { timeout: 20_000 });

    await page.getByRole('button', { name: /memo\.doc/ }).click();
    await expect(page.locator('[data-lookglass-error-message]')).toContainText('Word 97-2003 documents (.doc) cannot be previewed', {
      timeout: 20_000,
    });
  });
});
