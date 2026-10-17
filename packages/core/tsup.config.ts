import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts', 'src/meta.ts', 'src/report.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
});
