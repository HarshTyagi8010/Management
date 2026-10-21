import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// A full-page axe scan can take > 30 s on a loaded dev machine; a timeout is not a violation.
const AXE_TIMEOUT = 90_000;

async function openDashboard(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  // Wait for the lazily loaded chart so screenshots and scans see the final layout.
  await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test('dashboard renders under the production CSP without errors', async ({ page, problems }) => {
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  await openDashboard(page);
  expect(problems).toEqual([]);
});

test('calendar day buttons have spaced accessible names in a real browser', async ({ page }) => {
  await openDashboard(page);
  // jsdom omits spaces between flex items when computing names; Chrome must not.
  await expect(page.getByRole('button', { name: 'Tue 20 October 2026: 1 item', exact: true })).toBeVisible();
});

test('no horizontal page scroll', async ({ page }) => {
  await openDashboard(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('visual capture (manual review against reference required)', async ({ page }, testInfo) => {
  await openDashboard(page);
  await page.screenshot({ path: `../../test-results/visual/dashboard-${testInfo.project.name}.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `../../test-results/visual/dashboard-${testInfo.project.name}-dark.png`, fullPage: true });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe: no WCAG 2.2 AA violations (${scheme})`, async ({ page }) => {
    test.setTimeout(AXE_TIMEOUT);
    await page.emulateMedia({ colorScheme: scheme });
    await openDashboard(page);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    expect(summary).toEqual([]);
  });
}

test('axe: planned-module page has no violations', async ({ page }) => {
  test.setTimeout(AXE_TIMEOUT);
  await page.goto('/sales/invoices');
  await expect(page.getByRole('heading', { level: 1, name: 'Invoices' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});
