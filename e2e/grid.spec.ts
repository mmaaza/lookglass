import { expect, test, type Page } from '@playwright/test';

/**
 * CSV and workbook acceptance tests.
 *
 * Covers what only a browser proves: the two-axis virtual grid stays small,
 * tiles arrive for any scroll position, merged cells and cached formula values
 * render as Excel shows them, sheets switch, and a 400,000-row CSV opens
 * without being loaded whole.
 */

async function openFile(page: Page, name: RegExp) {
  await page.goto('/?offline=0');
  await expect(page.getByRole('heading', { name: 'lookglass' })).toBeVisible();
  await page.getByRole('button', { name }).click();
  await expect(page.locator('[data-lookglass-surface="grid"] [role="grid"]')).toBeVisible({ timeout: 60_000 });
}

const cell = (page: Page, r: number, c: number) => page.locator(`[data-lookglass-cell][data-row="${r}"][data-col="${c}"]`);
const rowInput = (page: Page) => page.getByRole('textbox', { name: 'Row number' });

test.describe('csv', () => {
  test('opens a 400,000-row CSV with a small DOM and header titles', async ({ page }) => {
    await openFile(page, /orders\.csv/);
    await expect(page.locator('[data-lookglass-page-total]')).toHaveText('/ 400,000');
    await expect(page.locator('[data-lookglass-col-header]').first()).toHaveText('id');
    await expect(cell(page, 0, 0)).toHaveText('1');
    // Hundreds of thousands of rows, a few hundred cells mounted.
    expect(await page.locator('[data-lookglass-cell]').count()).toBeLessThan(800);
  });

  test('keeps a quoted field with an embedded newline in one cell', async ({ page }) => {
    await openFile(page, /orders\.csv/);
    await rowInput(page).fill('12345');
    await rowInput(page).press('Enter');
    // Row 12,345 holds "first line\nsecond line"; it must not split the row.
    await expect(cell(page, 12344, 0)).toHaveText('12345', { timeout: 20_000 });
    await expect(cell(page, 12344, 5)).toContainText('first line');
    await expect(cell(page, 12345, 0)).toHaveText('12346');
  });

  test('search finds a value near the end and selects the cell', async ({ page }) => {
    await openFile(page, /orders\.csv/);
    const search = page.getByRole('searchbox', { name: 'Search document' });
    await search.fill('needle-marker');
    await search.press('Enter');
    await expect(page.locator('[data-lookglass-search-status]')).toHaveText('1 of 1', { timeout: 60_000 });
    await expect(rowInput(page)).toHaveValue('350000');
    await expect(cell(page, 349999, 5)).toHaveAttribute('data-lookglass-active', { timeout: 20_000 });
    await expect(page.locator('[data-lookglass-cell-content]')).toContainText('needle-marker');
  });

  test('detects semicolon delimiters in European CSV', async ({ page }) => {
    await openFile(page, /european\.csv/);
    await expect(page.locator('[data-lookglass-col-header]').nth(1)).toHaveText('Preis');
    await expect(cell(page, 0, 1)).toHaveText('0,25');
  });

  test('reads UTF-16 tab-separated text', async ({ page }) => {
    await openFile(page, /unicode\.tsv/);
    await expect(cell(page, 0, 0)).toHaveText('Zoë');
    await expect(cell(page, 1, 1)).toHaveText('東京');
  });
});

test.describe('workbooks', () => {
  test('shows merged titles, formatted values and cached formula results', async ({ page }) => {
    await openFile(page, /sales\.xlsx/);
    await expect(page.locator('[data-lookglass-title]')).toHaveText('Sales workbook');

    // A1:E1 is merged: one cell spanning five columns.
    const title = cell(page, 0, 0);
    await expect(title).toHaveText('Quarterly sales summary');
    const columnWidth = await page.locator('[data-lookglass-col-header]').first().evaluate((el) => el.clientWidth);
    expect(await title.evaluate((el) => el.clientWidth)).toBeGreaterThan(columnWidth * 3);

    await expect(cell(page, 3, 2)).toHaveText('$23,400.00');
    await expect(cell(page, 3, 3)).toHaveText('2026-03-01');
    await expect(cell(page, 3, 4)).toHaveText('18.0%');

    // The formula bar shows the formula; the cell shows the cached value.
    await cell(page, 7, 1).click();
    await expect(page.locator('[data-lookglass-cell-address]')).toHaveText('B8');
    await expect(page.locator('[data-lookglass-cell-content]')).toHaveText('=SUM(B4:B7)');
    await expect(cell(page, 7, 1)).toHaveText('6660');
  });

  test('switches sheets and marks hidden ones', async ({ page }) => {
    await openFile(page, /sales\.xlsx/);
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveText(['Summary', 'Orders', 'Wide', 'Hidden (hidden)']);

    await tabs.nth(2).click();
    await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(cell(page, 0, 0)).toHaveText('Col 1', { timeout: 30_000 });
  });

  test('scrolls horizontally past column Z on a wide sheet', async ({ page }) => {
    await openFile(page, /sales\.xlsx/);
    await page.getByRole('tab', { name: 'Wide' }).click();
    await expect(cell(page, 0, 0)).toHaveText('Col 1', { timeout: 30_000 });

    await page.locator('[data-lookglass-surface="grid"] [role="grid"]').evaluate((el) => el.scrollBy(8000, 0));
    await expect(page.locator('[data-lookglass-col-header]', { hasText: /^[A-Z]{2}$/ }).first()).toBeVisible();
    // Columns are virtualised horizontally as well as rows vertically.
    expect(await page.locator('[data-lookglass-col-header]').count()).toBeLessThan(40);
  });

  test('truncates a sheet past the row limit and says so', async ({ page }) => {
    await openFile(page, /sales\.xlsx/);
    await page.getByRole('tab', { name: 'Orders' }).click();
    await expect(page.locator('[data-lookglass-surface="grid"] [data-lookglass-notice]')).toContainText(
      'first 100,000 rows of 120,001',
      { timeout: 60_000 },
    );
  });

  test('searches the current sheet', async ({ page }) => {
    await openFile(page, /sales\.xlsx/);
    await page.getByRole('tab', { name: 'Orders' }).click();
    await expect(cell(page, 0, 0)).toHaveText('Order', { timeout: 60_000 });
    const search = page.getByRole('searchbox', { name: 'Search document' });
    await search.fill('needle-marker');
    await search.press('Enter');
    await expect(page.locator('[data-lookglass-search-status]')).toHaveText('1 of 1', { timeout: 60_000 });
    await expect(rowInput(page)).toHaveValue('90001');
  });

  test('reads legacy .xls with non-ASCII text', async ({ page }) => {
    await openFile(page, /legacy\.xls/);
    await expect(cell(page, 1, 0)).toHaveText('Zoë');
    await expect(cell(page, 2, 1)).toHaveText('Köln');
  });

  test('reads OpenDocument spreadsheets', async ({ page }) => {
    await openFile(page, /budget\.ods/);
    await expect(cell(page, 1, 0)).toHaveText('Rent');
    await expect(cell(page, 1, 1)).toHaveText('1200');
  });

  test('reads an HTML table saved as .xls', async ({ page }) => {
    await openFile(page, /export\.xls/);
    await expect(cell(page, 0, 0)).toHaveText('Ticket');
    await expect(cell(page, 2, 1)).toHaveText('Closed');
  });
});
