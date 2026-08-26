import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.wrangler/**',
      '**/next-env.d.ts',
      // Generated from wrangler.toml by `pnpm cf:types`; not ours to lint.
      '**/cloudflare-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Declaration files that bridge two external type systems. An interface
    // that only extends another is exactly the intent there, not an oversight.
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // The service worker runs in a worker scope, not a page or Node, so its
    // globals are neither set. Linted with those declared rather than exempted
    // entirely — a typo in `caches` should still be caught.
    files: ['**/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // Build scripts run under Node and legitimately use its globals.
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        crypto: 'readonly',
        Buffer: 'readonly',
        TextEncoder: 'readonly',
      },
    },
  },
  {
    // packages/crypto must stay isomorphic: no Node built-ins, no framework.
    files: ['packages/crypto/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'fs', 'crypto', 'path'], message: 'packages/crypto must stay isomorphic - use WebCrypto.' },
            { group: ['react', 'next', 'next/*'], message: 'packages/crypto must not depend on the framework.' },
          ],
        },
      ],
    },
  },
  prettier,
);
