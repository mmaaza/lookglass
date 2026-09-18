import { expect, test, type Page } from '@playwright/test';

/**
 * PDF acceptance tests.
 *
 * The range test is the one that justifies the architecture: it measures the
 * bytes the browser actually downloaded to show a page near the end of an
 * 11 MB file. The CJK test is the offline-assets proof: that text only
 * extracts if the CMap files were served, and it runs with the network off.
 */

const BIG_PDF_BYTES = 11_297_263;

async function openFile(page: Page, name: RegExp, query = '') {
  await page.goto(`/${query}`);
  await expect(page.getByRole('heading', { name: 'lookglass' })).toBeVisible();
  await page.getByRole('button', { name }).click();
}

async function waitForServiceWorker(page: Page) {
  await expect(page.getByText(/renderers cached: [1-9]/)).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });
}

const pageInput = (page: Page) => page.getByRole('textbox', { name: 'Page number' });

test.describe('pdf', () => {
  test('renders page 1 of a large PDF and reports its page count', async ({ page }) => {
    await openFile(page, /big\.pdf/, '?offline=0');
    await expect(page.locator('[data-lookglass-page="1"][data-lookglass-rendered]')).toBeVisible({ timeout: 40_000 });
    await expect(page.locator('[data-lookglass-page-total]')).toHaveText('/ 1,200');
    await expect(page.locator('[data-lookglass-title]')).toHaveText('Large fixture document');

    // Virtualised: 1,200 pages, a handful mounted.
    expect(await page.locator('[data-lookglass-page]').count()).toBeLessThan(10);
  });

  test('reaches page 1,150 while downloading a small fraction of the file', async ({ page }) => {
    let downloaded = 0;
    page.on('response', (response) => {
      if (!response.url().includes('/api/files/big.pdf') || response.request().method() !== 'GET') return;
      const length = Number(response.headers()['content-length'] ?? 0);
      downloaded += Number.isFinite(length) ? length : 0;
    });

    await openFile(page, /big\.pdf/, '?offline=0');
    await expect(page.locator('[data-lookglass-page="1"][data-lookglass-rendered]')).toBeVisible({ timeout: 40_000 });

    await pageInput(page).fill('1150');
    await pageInput(page).press('Enter');
    await expect(page.locator('[data-lookglass-page="1150"][data-lookglass-rendered]')).toBeVisible({ timeout: 40_000 });

    // Let any in-flight responses land before summing.
    await page.waitForTimeout(500);
    expect(downloaded).toBeGreaterThan(0);
    expect(downloaded).toBeLessThan(BIG_PDF_BYTES * 0.15);
  });

  test('keeps the page counter in step with scrolling', async ({ page }) => {
    await openFile(page, /big\.pdf/, '?offline=0');
    await expect(page.locator('[data-lookglass-page="1"][data-lookglass-rendered]')).toBeVisible({ timeout: 40_000 });

    const surface = page.locator('[data-lookglass-surface="pdf"]');
    const pageHeight = await page.locator('[data-lookglass-page="1"]').evaluate((element) => element.clientHeight);
    await surface.evaluate((element, height) => element.scrollBy(0, (height + 12) * 5), pageHeight);

    await expect(pageInput(page)).toHaveValue('6', { timeout: 10_000 });
  });

  test('search streams through the document and highlights the hit', async ({ page }) => {
    await openFile(page, /big\.pdf/, '?offline=0');
    await expect(page.locator('[data-lookglass-page="1"][data-lookglass-rendered]')).toBeVisible({ timeout: 40_000 });

    const search = page.getByRole('searchbox', { name: 'Search document' });
    await search.fill('needle-marker');
    await search.press('Enter');

    await expect(page.locator('[data-lookglass-search-status]')).toHaveText('1 of 1', { timeout: 90_000 });
    await expect(pageInput(page)).toHaveValue('1100');
    await expect(page.locator('[data-lookglass-page="1100"] mark[data-lookglass-active]')).toBeAttached({
      timeout: 20_000,
    });
  });

  test('outline entries and internal links navigate', async ({ page }) => {
    await openFile(page, /big\.pdf/, '?offline=0');
    await expect(page.locator('[data-lookglass-page="1"][data-lookglass-rendered]')).toBeVisible({ timeout: 40_000 });

    await page.getByRole('button', { name: 'Toggle outline' }).click();
    await page.getByRole('button', { name: 'Part 6 (page 501)' }).click();
    await expect(pageInput(page)).toHaveValue('501', { timeout: 20_000 });

    await page.getByRole('button', { name: 'Part 1 (page 1)' }).click();
    const link = page.locator('[data-lookglass-page="1"] [data-lookglass-link="internal"]');
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();
    await expect(pageInput(page)).toHaveValue('600', { timeout: 20_000 });
  });

  test('text layer makes page text selectable', async ({ page }) => {
    await openFile(page, /big\.pdf/, '?offline=0');
    await expect(page.locator('[data-lookglass-page="1"] .textLayer')).toContainText('Page 1', { timeout: 40_000 });
  });

  test('prompts for a password, rejects a wrong one, and opens with the right one', async ({ page }) => {
    await openFile(page, /locked\.pdf/, '?offline=0');

    const password = page.locator('[data-lookglass-password] input[type="password"]');
    await expect(password).toBeVisible({ timeout: 30_000 });

    await password.fill('not-it');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.locator('[data-lookglass-password-error]')).toBeVisible({ timeout: 20_000 });

    await password.fill('lookglass');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.locator('[data-lookglass-page="1"][data-lookglass-rendered]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-lookglass-page="1"] .textLayer')).toContainText('Secret unlocked page', {
      timeout: 20_000,
    });
  });

  test('cancelling the password prompt leaves a retryable error', async ({ page }) => {
    await openFile(page, /locked\.pdf/, '?offline=0');
    await expect(page.locator('[data-lookglass-password]')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('[data-lookglass-error-message]')).toContainText(/password/i, { timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('extracts CJK text through CMaps, with the network off', async ({ page, context }) => {
    const japanese = '日本語のテキスト';

    await page.goto('/');
    await waitForServiceWorker(page);

    // First open online: renders, and caches the document in the background.
    await page.getByRole('button', { name: /cjk\.pdf/ }).click();
    await expect(page.locator('[data-lookglass-page="1"] .textLayer')).toContainText(japanese, { timeout: 40_000 });
    await expect(page.getByTestId('cached-note')).toContainText('cjk.pdf', { timeout: 30_000 });

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'lookglass' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /cjk\.pdf/ }).click();

    // Offline, from OPFS, with CMaps served by the service worker.
    await expect(page.locator('[data-lookglass-statusbar]')).toContainText('offline copy', { timeout: 40_000 });
    await expect(page.locator('[data-lookglass-page="1"] .textLayer')).toContainText(japanese, { timeout: 40_000 });

    await context.setOffline(false);
  });
});
