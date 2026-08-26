import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/web/lib/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: {
        // packages/crypto is held to a much higher bar in its own run.
        lines: 70,
        functions: 70,
      },
    },
  },
});
