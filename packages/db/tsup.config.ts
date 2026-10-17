import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node22',
  },
  {
    // Self-contained copy (core, drizzle-orm, postgres, ... inlined) for hosts
    // whose function bundles lose pnpm's workspace symlinks (Vercel). It stays
    // in dist/ because migrations are located as ../drizzle relative to it.
    // PGlite is a dev/test fallback only and stays an optional external.
    entry: { bundle: 'src/index.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: false,
    target: 'node22',
    splitting: false,
    noExternal: [/^(?!@electric-sql\/pglite|drizzle-orm\/pglite)/],
    external: ['@electric-sql/pglite', /^drizzle-orm\/pglite/],
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  },
]);
