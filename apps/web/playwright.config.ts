import { defineConfig } from '@playwright/test';

/**
 * E2E runs against the production build served by `vite preview` (with CSP headers),
 * which proxies /api to a real API on its own throwaway MongoDB replica set.
 * Uses the locally installed Google Chrome (`channel: 'chrome'`), so no browser
 * download is needed. All output stays inside PROJECT_ROOT.
 * Run with TMP/TEMP pointing at PROJECT_ROOT/.tmp (see package script) so the
 * temporary browser profile is created inside the project too.
 */
const E2E_API_PORT = '4100';

const viewports = {
  'desktop-1440': { width: 1440, height: 900 },
  'laptop-1280': { width: 1280, height: 800 },
  'tablet-1024': { width: 1024, height: 768 },
  'tablet-768': { width: 768, height: 1024 },
  'mobile-390': { width: 390, height: 844 },
  'mobile-360': { width: 360, height: 740 },
} as const;

export default defineConfig({
  testDir: 'e2e',
  outputDir: '../../test-results/e2e',
  fullyParallel: true,
  // Several Chrome instances at once starved the dev machine (timeouts, aborted navigations); keep this modest.
  workers: 3,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: '../../playwright-report', open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    trace: 'retain-on-failure',
    acceptDownloads: false,
  },
  projects: Object.entries(viewports).map(([name, viewport]) => ({
    name,
    use: { viewport, isMobile: viewport.width < 768, hasTouch: viewport.width < 768 },
  })),
  webServer: [
    {
      command: 'npm run e2e:server -w @bizmgmt/api',
      cwd: '../..',
      url: `http://127.0.0.1:${E2E_API_PORT}/api/v1/ready`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { E2E_API_PORT },
    },
    {
      command: 'npm run build && npx vite preview',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 180_000,
      env: { PREVIEW_API_PORT: E2E_API_PORT },
    },
  ],
});
