import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.cache/**', '.tmp/**', '.artifacts/**', 'coverage/**', 'test-results/**', 'playwright-report/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // Money must never be computed with binary floating point (docs/architecture/financial-policy.md).
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat is banned: use decimal strings and the domain decimal library.',
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned (XSS).',
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'localStorage', message: 'Do not store auth or business data in localStorage.' },
        { object: 'window', property: 'localStorage', message: 'Do not store auth or business data in localStorage.' },
      ],
    },
  },
);
