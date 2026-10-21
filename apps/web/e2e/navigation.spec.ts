import { expect, test } from './fixtures';

test.describe('keyboard (desktop)', () => {
  // Describe-level skip: evaluated before the auto sign-in fixture, so skipped tests do no work.
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, 'expanded-sidebar layout only');

  test('skip link is the first tab stop and moves focus to main', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
  });

  test('navigation groups open with the keyboard and links navigate', async ({ page }) => {
    await page.goto('/');
    const sales = page.getByRole('button', { name: 'Sales', exact: true });
    await sales.focus();
    await page.keyboard.press('Enter');
    await expect(sales).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('link', { name: 'Invoices', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/sales\/invoices$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Invoices' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Invoices', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#main')).toBeFocused();
  });

  test('"New" menu is operable by keyboard', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /New/ }).focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('KPI definition opens from the keyboard', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'What is “Receivables”?' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toContainText('Outstanding on issued invoices');
  });
});

test.describe('mobile drawer', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 1024, 'drawer layout only');

  test('opens, traps focus, closes on Escape and restores focus', async ({ page }) => {
    await page.goto('/');
    const open = page.getByRole('button', { name: 'Open navigation' });
    await open.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(open).toBeFocused();
  });

  test('navigating from the drawer closes it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: 'Money', exact: true }).click();
    await drawer.getByRole('link', { name: 'Receipts', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Receipts' })).toBeVisible();
  });
});
