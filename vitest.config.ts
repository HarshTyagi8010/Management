import react from '@vitejs/plugin-react';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Workspace packages are resolved from TypeScript source via the "source" export condition.
const nodeProject = (name: string, root: string) => ({
  extends: false as const,
  root,
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  resolve: { conditions: ['source', ...defaultServerConditions] },
  test: { name, environment: 'node' as const, include: ['src/**/*.test.ts'] },
});

export default defineConfig({
  cacheDir: '.cache/vitest',
  test: {
    reporters: ['default'],
    outputFile: { junit: 'test-results/junit.xml' },
    projects: [
      nodeProject('contracts', 'packages/contracts'),
      nodeProject('domain', 'packages/domain'),
      nodeProject('api', 'apps/api'),
      {
        ...nodeProject('api-int', 'apps/api'),
        // Real MongoDB replica set (test/global-setup.ts). Files run in parallel, each on its own database.
        test: {
          name: 'api-int',
          environment: 'node' as const,
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
      nodeProject('worker', 'apps/worker'),
      {
        extends: false,
        root: 'packages/ui',
        plugins: [react()],
        resolve: { conditions: ['source', ...defaultClientConditions] },
        test: { name: 'ui', environment: 'jsdom', testTimeout: 30_000, include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
      },
      {
        extends: false,
        root: 'apps/web',
        plugins: [react()],
        resolve: { conditions: ['source', ...defaultClientConditions] },
        test: { name: 'web', environment: 'jsdom', testTimeout: 30_000, include: ['src/**/*.test.tsx', 'src/**/*.test.ts'] },
      },
    ],
  },
});
