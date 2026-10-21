import { test as base, expect, type Page } from '@playwright/test';

export const owner = () => ({
  email: process.env.E2E_OWNER_EMAIL ?? '',
  password: process.env.E2E_OWNER_PASSWORD ?? '',
  name: process.env.E2E_OWNER_NAME ?? '',
});

/** Signs in through the real sign-in form (exercises CSRF, cookies and the redirect back). */
export async function signInWithForm(page: Page, email = owner().email, password = owner().password, path = '/login') {
  await page.goto(path);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * Applied to every test automatically: a deterministic API health stub (so the
 * version label is stable in screenshots), a collector for CSP violations and
 * uncaught errors, and — unless a test opts out with `test.use({ signedIn: false })` —
 * a signed-in owner session.
 */
export const test = base.extend<{ problems: string[]; signedIn: boolean }>({
  signedIn: [true, { option: true }],
  problems: [
    async ({ page, signedIn }, use) => {
      const problems: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(msg.text())) problems.push(msg.text());
      });
      page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
      await page.route('**/api/v1/health', (route) =>
        route.fulfill({
          json: { status: 'ok', service: 'api', version: '0.1.0', time: '2026-10-19T12:00:00.000Z' },
        }),
      );
      if (signedIn) {
        await signInWithForm(page);
        // Sign-in hashes a password and runs several queries; allow for a busy machine.
        await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible({ timeout: 30_000 });
        // Leave the app so each test's first page.goto is a fresh load (no carried-over focus position).
        await page.goto('about:blank');
      }
      await use(problems);
    },
    { auto: true },
  ],
});

export { expect };
