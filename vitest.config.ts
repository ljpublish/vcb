import { defineConfig } from 'vitest/config';

// Unit tests: pure TS in Node (no DOM, no WebGL). Browser play-tests live in tests/e2e (Playwright).
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
