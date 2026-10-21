import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { expect, owner, signInWithForm, test } from './fixtures';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const AXE_TIMEOUT = 90_000;

test.describe('signed out', () => {
  test.use({ signedIn: false });

  test('redirects to sign-in and returns to the requested page', async ({ page, problems }) => {
    await page.goto('/settings/users');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await signInWithForm(page, owner().email, owner().password, page.url().replace(/^.*?:\/\/[^/]+/, ''));
    await expect(page.getByRole('heading', { level: 1, name: 'Users & roles' })).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('keeps the session cookie out of reach of scripts', async ({ page, context }) => {
    await signInWithForm(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    const sid = (await context.cookies()).find((c) => c.name === '__Host-sid');
    expect(sid).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-sid');
    // Reading storage here proves the app keeps nothing auth-related in it.
    // eslint-disable-next-line no-restricted-properties
    expect(await page.evaluate(() => JSON.stringify({ ...window.sessionStorage }) + JSON.stringify(Object.keys(window.localStorage)))).not.toMatch(/sid|csrf|token/i);
  });

  test('shows a clear message for a wrong password', async ({ page }) => {
    // An unknown account gets the identical answer; using it keeps the shared owner below the lockout threshold.
    await signInWithForm(page, `nobody.${randomBytes(3).toString('hex')}@example.test`, 'not-the-right-password');
    await expect(page.getByRole('alert')).toHaveText('Incorrect email or password');
  });

  test('sign-in page has no WCAG 2.2 AA violations', async ({ page }, testInfo) => {
    test.setTimeout(AXE_TIMEOUT);
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await page.screenshot({ path: `../../test-results/visual/login-${testInfo.project.name}.png`, fullPage: true });
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });

  test('creates an account and business, then signs out and back in', async ({ page }, testInfo) => {
    // One project only: every sign-up counts against the per-IP limit.
    test.skip(testInfo.project.name !== 'desktop-1440', 'sign-up runs once per suite');
    const email = `e2e.signup.${randomBytes(4).toString('hex')}@example.test`;
    const password = `Signup-passphrase-${randomBytes(4).toString('hex')}`;
    await page.goto('/signup');
    await page.getByLabel('Your name').fill('Ravi Kumar (test)');
    await page.getByLabel('Business name').fill('Sample Hardware (test)');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Sample Hardware (test)').first()).toBeVisible();

    await page.getByRole('button', { name: /account menu for Ravi Kumar \(test\)/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    // The old session is gone server-side, not just in the browser.
    await page.goto('/settings/users');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

    // Signing in again returns to the page that asked for it.
    await signInWithForm(page, email, password, '/login');
    await expect(page.getByRole('heading', { level: 1, name: 'Users & roles' })).toBeVisible();
  });
});

test.describe('signed in', () => {
  for (const [path, heading] of [
    ['/settings/users', 'Users & roles'],
    ['/settings/audit', 'Audit log'],
    ['/account', 'Account & security'],
  ] as const) {
    test(`${heading} has no WCAG 2.2 AA violations and no horizontal scroll`, async ({ page, problems }, testInfo) => {
      test.setTimeout(AXE_TIMEOUT);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      // Wait for data, not skeletons. Tables render one layout per breakpoint, so match the visible copy.
      const loaded = { '/settings/users': owner().email, '/settings/audit': 'Created business', '/account': '(this device)' }[path];
      await expect(page.getByText(loaded).filter({ visible: true }).first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `../../test-results/visual/${path.split('/').at(-1)}-${testInfo.project.name}.png`, fullPage: true });
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
      expect(problems).toEqual([]);
    });
  }

  test('two-step setup shows a locally rendered QR code', async ({ page, problems }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'one project is enough; it does not change the shared account');
    await page.goto('/account');
    await page.getByRole('button', { name: 'Set up two-step verification' }).click();
    const qr = page.getByRole('img', { name: 'QR code for your authenticator app' });
    await expect(qr).toBeVisible();
    expect(await qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(problems).toEqual([]);
  });
});
