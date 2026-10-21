import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Resolve workspace packages from TypeScript source during development and build.
  resolve: { conditions: ['source', ...defaultClientConditions] },
  cacheDir: '../../.cache/vite/web',
  optimizeDeps: {
    include: ['recharts'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false } },
  },
  // Production-like headers for `vite preview`, used by the E2E suite to prove the app runs under the
  // CSP in docs/security/security.md §4. The real host (CloudFront) must send the same policy.
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    // Same-origin API, as in production (CloudFront path routing). E2E points this at its own API.
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.PREVIEW_API_PORT ?? 4000}`, changeOrigin: false } },
    headers: {
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  },
  build: { outDir: 'dist', sourcemap: true, target: ['chrome111', 'edge111', 'firefox128', 'safari16.4'] },
});
