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
