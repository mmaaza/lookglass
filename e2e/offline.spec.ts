import { expect, test, type Page } from '@playwright/test';

/**
 * Acceptance test for M0.
 *
 * Each assertion maps to a subsystem that has no meaningful unit test:
 *  - a large log renders            -> worker RPC + line index + virtualiser
 *  - the DOM stays small            -> virtualisation is real, not aspirational
 *  - search finds a late match      -> streaming worker search + page jump
 *  - offline reopen still works     -> service worker + OPFS cache
 */

async function warmAndWait(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'lookglass' })).toBeVisible();
  // `warmCache()` runs on idle and reports into the header once finished.
  await expect(page.getByText(/renderers cached: [1-9]/)).toBeVisible({ timeout: 30_000 });
  // Give the service worker a moment to take control of the page.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 15_000 });
}

test.describe('lookglass playground', () => {
  test('renders a large log with a virtualised DOM', async ({ page }) => {
    await warmAndWait(page);
    await page.getByRole('button', { name: /app\.log/ }).click();

    await expect(page.locator('[data-lookglass-surface="text"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-lookglass-statusbar]')).toContainText('lines');

    // 40k lines in the file; only a viewport's worth may exist in the DOM.
    const rendered = await page.locator('[data-lookglass-line]').count();
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(200);
  });

  test('search finds a match deep in the file and scrolls to it', async ({ page }) => {
    await warmAndWait(page);
    await page.getByRole('button', { name: /app\.log/ }).click();
    await expect(page.locator('[data-lookglass-surface="text"]')).toBeVisible({ timeout: 30_000 });

    const search = page.getByRole('searchbox', { name: 'Search document' });
    await search.fill('needle-marker');
    await search.press('Enter');

    await expect(page.locator('[data-lookglass-search-status]')).toContainText(/of \d+/, { timeout: 30_000 });
    await expect(page.locator('[data-lookglass-match]').first()).toBeVisible();
  });

  test('renders an image', async ({ page }) => {
    await warmAndWait(page);
    await page.getByRole('button', { name: /logo\.png/ }).click();
    await expect(page.locator('[data-lookglass-surface="image"] canvas')).toBeVisible({ timeout: 20_000 });
  });

  test('reports an unsupported format instead of failing silently', async ({ page }) => {
    await warmAndWait(page);
    await page.getByRole('button', { name: /archive\.zip/ }).click();
    // No renderer handles ZIP archives; the viewer must say so clearly rather
    // than leaving a spinner on screen forever.
    await expect(page.locator('[data-lookglass-error]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-lookglass-error-message]')).toContainText(/archive\.zip/i);
  });

  test('opens a previously viewed server document while offline', async ({ page, context }) => {
    await warmAndWait(page);

    // First open while online: the bytes stream into OPFS.
    await page.getByRole('button', { name: /notes\.txt/ }).click();
    await expect(page.locator('[data-lookglass-surface="text"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-lookglass-statusbar]')).toContainText('lines');
    // Caching runs in the background; going offline before it finishes would
    // test nothing.
    await expect(page.getByTestId('cached-note')).toContainText('notes.txt', { timeout: 30_000 });

    await context.setOffline(true);
    await expect(page.locator('.pill-offline')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'lookglass' })).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /notes\.txt/ }).click();
    await expect(page.locator('[data-lookglass-surface="text"]')).toBeVisible({ timeout: 30_000 });
    // The status bar names the offline copy, proving OPFS served the bytes.
    await expect(page.locator('[data-lookglass-statusbar]')).toContainText('offline copy');

    await context.setOffline(false);
  });
});
