import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // Every file boots its own PGlite (WASM Postgres) + migrations in beforeAll. That is
    // CPU-bound, and on a 2-vCPU CI runner (turbo runs db/web tests side by side) it can
    // take far longer than the 10s default.
    hookTimeout: 60_000,
    coverage: { provider: 'v8', include: ['src/**/*.ts'] },
  },
});
