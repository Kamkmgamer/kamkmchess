import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    // KHA-26 establishes the entry point. Product fixtures start with KHA-27/28.
    passWithNoTests: true,
  },
});
