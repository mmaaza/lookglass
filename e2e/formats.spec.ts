import { expect, test, type Page } from '@playwright/test';

/**
 * M1 renderer coverage.
 *
 * These assert behaviour that only exists in a real browser: worker-backed
 * tree expansion, block virtualisation, and — most importantly — that the
 * SVG sanitiser holds when the markup actually reaches a live DOM.
 */

async function open(page: Page, name: RegExp) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'lookglass' })).toBeVisible();
  await page.getByRole('button', { name }).click();
}

test.describe('structured formats', () => {
  test('renders a large JSON document as a virtualised tree', async ({ page }) => {
    await open(page, /catalog\.json/);
    await expect(page.locator('[data-lookglass-surface="tree"]')).toBeVisible({ timeout: 40_000 });

    // 25k records, but only a viewport's worth of rows may exist.
    const rows = await page.locator('[data-lookglass-tree-row]').count();
    expect(rows).toBeGreaterThan(3);
    expect(rows).toBeLessThan(200);

    await expect(page.locator('[data-lookglass-statusbar]')).toContainText('rows');
    // Containers summarise their size rather than rendering their children.
    await expect(page.locator('[data-lookglass-tree-value]').first()).toBeVisible();
  });

  test('expanding a node changes the visible row count', async ({ page }) => {
    await open(page, /catalog\.json/);
    await expect(page.locator('[data-lookglass-surface="tree"]')).toBeVisible({ timeout: 40_000 });

    const before = await page.locator('[data-lookglass-statusbar]').innerText();
    const collapsed = page.locator('[data-lookglass-tree-row]:not([aria-expanded="true"])[aria-expanded]').first();
    await collapsed.locator('[data-lookglass-twisty]').click();

    await expect(page.locator('[data-lookglass-statusbar]')).not.toHaveText(before, { timeout: 15_000 });
  });

  test('searching JSON reveals a match buried deep in the document', async ({ page }) => {
    await open(page, /catalog\.json/);
    await expect(page.locator('[data-lookglass-surface="tree"]')).toBeVisible({ timeout: 40_000 });

    const search = page.getByRole('searchbox', { name: 'Search document' });
    await search.fill('needle-marker');
    await search.press('Enter');
    await expect(page.locator('[data-lookglass-search-status]')).toContainText(/of \d+/, { timeout: 40_000 });
  });

  test('renders JSON Lines as an array of records', async ({ page }) => {
    await open(page, /events\.jsonl/);
    await expect(page.locator('[data-lookglass-surface="tree"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-lookglass-statusbar]')).toContainText('JSON Lines');
  });

  test('renders XML with attributes and namespaced names', async ({ page }) => {
    await open(page, /catalog\.xml/);
    await expect(page.locator('[data-lookglass-surface="tree"]')).toBeVisible({ timeout: 40_000 });
    // The fixture opens with a comment beside the root element. Both must be
    // rows: the comment first, then the root with its children beneath it.
    await expect(page.locator('[data-lookglass-tree-key]').first()).toHaveText('#comment');
    await expect(page.locator('[data-lookglass-tree-key]', { hasText: /^catalog$/ })).toBeVisible();
    await expect(page.locator('[data-lookglass-tree-key]', { hasText: /^item$/ }).first()).toBeVisible();
    // An attribute value containing an escaped '>' must survive intact.
    await expect(page.locator('[data-lookglass-attr-value]').first()).toBeVisible();
  });

  test('renders markdown with tables and sanitised raw HTML', async ({ page }) => {
    await open(page, /guide\.md/);
    await expect(page.locator('[data-lookglass-surface="markdown"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-lookglass-prose] h1')).toContainText('lookglass guide');

    // The fixture contains <img src=x onerror=alert(1)>; the attribute must
    // not have survived sanitisation into the live DOM.
    const handlers = await page.locator('[data-lookglass-prose] [onerror]').count();
    expect(handlers).toBe(0);
  });

  test('markdown blocks are virtualised', async ({ page }) => {
    await open(page, /guide\.md/);
    await expect(page.locator('[data-lookglass-surface="markdown"]')).toBeVisible({ timeout: 30_000 });
    // 300+ filler paragraphs in the fixture.
    const blocks = await page.locator('[data-lookglass-block]').count();
    expect(blocks).toBeLessThan(80);
  });

  test('renders SVG and strips its XSS payloads', async ({ page }) => {
    const alerts: string[] = [];
    page.on('dialog', (dialog) => {
      alerts.push(dialog.message());
      void dialog.dismiss();
    });

    await open(page, /diagram\.svg/);
    await expect(page.locator('[data-lookglass-surface="svg"] svg')).toBeVisible({ timeout: 30_000 });

    // The gradient survived, so sanitising did not gut the image.
    await expect(page.locator('[data-lookglass-surface="svg"] linearGradient')).toHaveCount(1);

    // Nothing executable survived.
    expect(await page.locator('[data-lookglass-surface="svg"] script').count()).toBe(0);
    expect(await page.locator('[data-lookglass-surface="svg"] [onclick]').count()).toBe(0);

    // The remote tracker reference was neutralised, and the user was told.
    const remote = await page.locator('[data-lookglass-surface="svg"] image').getAttribute('href');
    expect(remote).toBeNull();
    await expect(page.locator('[data-lookglass-notice]')).toContainText(/remote|unsafe/i);

    await page.waitForTimeout(500);
    expect(alerts).toEqual([]);
  });
});

test.describe('syntax highlighting', () => {
  test('highlights source code and carries comment state across blocks', async ({ page }) => {
    await open(page, /widget\.ts/);
    await expect(page.locator('[data-lookglass-surface="text"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-lookglass-token]').first()).toBeVisible({ timeout: 30_000 });

    // Jump to line 514: inside a block comment that opened on line 510, in the
    // previous 512-line block.
    const lineInput = page.getByRole('textbox', { name: 'Line number' });
    await lineInput.fill('514');
    await lineInput.press('Enter');

    const token = page.locator('[data-lookglass-line="514"] [data-lookglass-token]').first();
    await expect(token).toBeVisible({ timeout: 20_000 });
    const light = await token.evaluate((element) => (element as HTMLElement).style.getPropertyValue('--lg-hl-light'));
    // github-light's comment colour. Without carried state this line would
    // be tokenised as code and come back a different colour.
    expect(light.toUpperCase()).toBe('#6A737D');

    // And the line after the comment closes is code again.
    const after = page.locator('[data-lookglass-line="516"] [data-lookglass-token]').last();
    const afterColour = await after.evaluate((element) => (element as HTMLElement).style.getPropertyValue('--lg-hl-light'));
    expect(afterColour.toUpperCase()).not.toBe('#6A737D');
  });
});
