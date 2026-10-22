import { expect, test } from './fixtures';

test.describe('Phase 10: Real-Browser Acceptance Pass', () => {
  test('1. renders Compliance Capabilities overview with statutory boundaries', async ({ page }) => {
    await page.goto('/reports/compliance');
    await expect(page.getByRole('heading', { level: 1, name: 'Compliance & Statutory Capabilities' })).toBeVisible();
    await expect(page.getByText('PREPARATION ONLY — NOT FILED')).toBeVisible();
    await expect(page.getByText('Statutory Boundary Notice')).toBeVisible();
  });

  test('2. navigates and displays Outward Supply Register with filters and export control', async ({ page }) => {
    await page.goto('/reports/outward-register');
    await expect(page.getByRole('heading', { level: 1, name: 'Outward Supply Preparation Register' })).toBeVisible();
    await expect(page.getByLabel('Business Entity')).toBeVisible();
    await expect(page.getByLabel('From Date')).toBeVisible();
    await expect(page.getByLabel('To Date')).toBeVisible();
    await expect(page.getByRole('button', { name: /Export/i })).toBeVisible();
  });

  test('3. navigates and displays Purchase Register with REVIEW_REQUIRED disclosure', async ({ page }) => {
    await page.goto('/reports/purchase-register');
    await expect(page.getByRole('heading', { level: 1, name: 'Purchase Register & ITC Review Preparation' })).toBeVisible();
    await expect(page.getByText('PREPARATION ONLY — NOT FILED')).toBeVisible();
    await expect(page.getByRole('button', { name: /Export/i })).toBeVisible();
  });

  test('4. navigates and displays HSN/SAC Summary with B2B and B2C tabs', async ({ page }) => {
    await page.goto('/reports/hsn-summary');
    await expect(page.getByRole('heading', { level: 1, name: 'HSN/SAC Summary (GSTR-1 Table 12)' })).toBeVisible();
    await expect(page.getByRole('button', { name: /B2B/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /B2C/i })).toBeVisible();
  });

  test('5. navigates and displays Document Issued Summary with supported and excluded series', async ({ page }) => {
    await page.goto('/reports/document-summary');
    await expect(page.getByRole('heading', { level: 1, name: 'Documents Issued Summary (GSTR-1 Table 13)' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /Table 13 Statutory Documents/i })).toBeVisible();
    await expect(page.getByText(/Internal Excluded Series/i)).toBeVisible();
  });

  test('6. navigates and displays Financial Reconciliation with control accounts and drill-down', async ({ page }) => {
    await page.goto('/reports/reconciliation');
    await expect(page.getByRole('heading', { level: 1, name: 'Financial Reconciliation' })).toBeVisible();
    await expect(page.getByLabel('Reconciliation Mode')).toBeVisible();
  });

  test('7. navigates to Period Locks and verifies Period-Close Readiness Coordinator and legacy lock form', async ({ page }) => {
    await page.goto('/settings/period-locks');
    await expect(page.getByRole('heading', { level: 1, name: 'Period-Close Readiness & Posting Locks' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Period-Close Readiness Evaluation' })).toBeVisible();
    await expect(page.getByLabel('Closing Mode')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Re-evaluate Checklist' })).toBeVisible();
    await expect(page.getByText('Lock postings up to and including')).toBeVisible();
  });

  test('8. captures visual screenshots across viewports for manual visual review', async ({ page }, testInfo) => {
    await page.goto('/reports/compliance');
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: `../../test-results/visual/capabilities-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.goto('/reports/reconciliation');
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: `../../test-results/visual/reconciliation-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await page.goto('/settings/period-locks');
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: `../../test-results/visual/period-locks-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });
});
