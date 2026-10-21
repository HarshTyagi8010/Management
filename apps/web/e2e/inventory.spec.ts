import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const AXE_TIMEOUT = 90_000;

/** Phase 5 screens with the text that shows their data has loaded. */
const pages = () =>
  [
    ['stock', '/inventory/stock', 'Stock', 'Test hex bolt (e2e)'],
    ['warehouses', '/inventory/warehouses', 'Warehouses', 'Main godown (e2e)'],
    ['ledger', '/inventory/ledger', 'Stock ledger', 'Opening stock'],
    ['transfers', '/inventory/transfers', 'Transfers', 'TRF-000001'],
    ['transfer-draft', `/inventory/transfers/${process.env.E2E_TRANSFER_ID}`, 'Transfer TRF-000001', 'Dispatch now'],
    ['transfer-new', '/inventory/transfers/new', 'New transfer', 'Find stock items'],
    ['adjustments', '/inventory/adjustments', 'Adjustments & counts', 'OPN-000001'],
    ['opening', `/inventory/adjustments/${process.env.E2E_OPENING_ID}`, 'Opening stock OPN-000001', 'Posted'],
    ['adjustment-new', '/inventory/adjustments/new', 'New stock adjustment', 'Leave the cost empty'],
    ['count', `/inventory/counts/${process.env.E2E_COUNT_ID}`, 'Stock count CNT-000001', 'Save counts'],
    ['period-locks', '/settings/period-locks', 'Period locks', 'No period is locked'],
  ] as const;

test.describe('inventory screens', () => {
  for (const index of pages().keys()) {
    test(`page ${index + 1}: WCAG 2.2 AA, no horizontal scroll, no CSP errors`, async ({ page, problems }, testInfo) => {
      test.setTimeout(AXE_TIMEOUT);
      const [name, path, heading, loaded] = pages()[index] ?? [];
      if (!path || !heading || !loaded) throw new Error('missing page');
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.getByText(loaded).filter({ visible: true }).first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} scrolls sideways`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `../../test-results/visual/${name}-${testInfo.project.name}.png`, fullPage: true });
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), name).toEqual([]);
      expect(problems).toEqual([]);
    });
  }
});

// Only the journey saves a file (the transfer note); downloads go to the run's temporary folder.
test.describe('stock journey', () => {
  test.use({ acceptDownloads: true });

  test('moves stock between warehouses and the records still agree', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'changes shared data; one project is enough');
    test.setTimeout(AXE_TIMEOUT);
    await page.goto('/inventory/transfers/new');
    await page.getByRole('combobox', { name: 'From warehouse' }).selectOption({ label: 'MAIN · Main godown (e2e)' });
    await page.getByRole('combobox', { name: 'To warehouse' }).selectOption({ label: 'CITY · City shop (e2e)' });
    await page.getByRole('combobox', { name: 'Item 1' }).selectOption({ label: 'E2E-BOLT · Test hex bolt (e2e)' });
    await page.getByRole('textbox', { name: /Quantity 1/ }).fill('5');
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^Transfer TRF-/ })).toBeVisible();
    await page.getByRole('button', { name: 'Dispatch now' }).click();
    await expect(page.getByText('In transit').first()).toBeVisible();
    // The worker renders the transfer note after dispatch; the page picks it up by itself.
    const download = page.getByRole('button', { name: 'Download transfer note (PDF)' });
    await expect(download).toBeVisible({ timeout: 30_000 });
    const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
    expect(file.suggestedFilename()).toMatch(/^TRF-\d{6}\.pdf$/);
    await page.getByRole('button', { name: 'Receive goods' }).click();
    await expect(page.getByText('Received', { exact: true }).first()).toBeVisible();

    await page.goto('/inventory/ledger');
    await expect(page.getByRole('cell', { name: 'Transfer in' }).first()).toBeVisible();

    await page.goto('/inventory/stock');
    await page.getByRole('tab', { name: 'Check records' }).click();
    await page.getByRole('button', { name: 'Run the check' }).click();
    // The manual check's result (the automatic daily check shows a similar line above it).
    await expect(page.getByRole('status').filter({ hasText: /^All \d+ balances and \d+ valuations agree with the ledger/ })).toBeVisible();
  });
});
