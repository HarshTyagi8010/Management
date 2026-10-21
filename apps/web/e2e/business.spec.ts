import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { expect, test } from './fixtures';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const AXE_TIMEOUT = 90_000;

/** Phase 4 screens with the text that shows their data has loaded. */
const pages = () =>
  [
    ['company', '/settings/company', 'Company & GST', 'Example Traders Private Limited (test)'],
    ['entity', `/settings/company/${process.env.E2E_ENTITY_ID}`, 'Example Traders Private Limited (test)', 'GST registrations'],
    ['series', '/settings/series', 'Document series', 'Tax invoices'],
    ['workflow', '/settings/workflow', 'Workflow', 'Stock goes out on'],
    ['tax', '/settings/tax', 'Tax rates', 'Test goods (no rate)'],
    ['items', '/inventory/items', 'Items', 'Test hex bolt (e2e)'],
    ['item', `/inventory/items/${process.env.E2E_ITEM_ID}`, 'Test hex bolt (e2e)', 'Prices'],
    ['customers', '/parties/customers', 'Customers', 'Test Buyers (e2e)'],
    ['party', `/parties/${process.env.E2E_PARTY_ID}`, 'Test Buyers (e2e)', 'Addresses'],
    ['follow-ups', '/parties/follow-ups', 'Follow-ups', 'Call about the test order'],
  ] as const;

test.describe('business setup screens', () => {
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

test('adds a customer, flags a duplicate phone and adds a follow-up', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'changes shared data; one project is enough');
  const name = `New Buyer ${randomBytes(2).toString('hex')} (e2e)`;
  await page.goto('/parties/customers');
  await page.getByRole('link', { name: 'Add customer' }).click();
  // Required labels contain a visual "*", so match fields by accessible name.
  const textbox = (label: string) => page.getByRole('textbox', { name: label, exact: true });
  await textbox('Name').fill(name);
  await page.getByLabel('Address line 1').fill('2 Test Market Road');
  await page.getByLabel('City or town').fill('Pune');
  await page.getByRole('combobox', { name: 'State', exact: true }).selectOption('27');
  await page.getByLabel('PIN code').fill('411001');
  await page.getByRole('button', { name: 'Add contact' }).click();
  await textbox('Name').nth(1).fill('Test Person');
  await page.getByLabel('Phone').fill('090000 00001');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // Same phone as the seeded customer (written differently).
  await expect(page.getByText('Test Buyers (e2e) has the same phone')).toBeVisible();
  await page.getByRole('button', { name: 'It’s different, save anyway' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  await page.getByRole('tab', { name: 'Notes & follow-ups' }).click();
  await page.getByLabel('What to do').fill('Send the price list');
  await page.getByRole('button', { name: 'Add follow-up' }).click();
  await expect(page.getByText('Send the price list')).toBeVisible();
  await page.goto('/parties/follow-ups');
  await expect(page.getByText('Send the price list').filter({ visible: true }).first()).toBeVisible();
});
