import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    testTimeout: 120000, // CDK stack synthesis with Lambda bundling can be slow
    hookTimeout: 120000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
