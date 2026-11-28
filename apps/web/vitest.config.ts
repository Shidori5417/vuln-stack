import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // Some suites boot an in-memory PGlite + migrations in beforeAll; see packages/db/vitest.config.ts.
    hookTimeout: 60_000,
    coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'] },
  },
});
