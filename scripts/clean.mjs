// Removes build output inside PROJECT_ROOT only. Paths are fixed and verified
// to resolve under the repository root before deletion; nothing is globbed.
import { rmSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'packages/contracts/dist',
  'apps/api/dist',
  'apps/worker/dist',
  'apps/web/dist',
  'coverage',
  'test-results',
  'playwright-report',
];

for (const target of targets) {
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) throw new Error(`Refusing to delete outside root: ${abs}`);
  rmSync(abs, { recursive: true, force: true });
  console.log(`removed ${rel}`);
}
