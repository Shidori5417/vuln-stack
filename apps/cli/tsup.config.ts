import { defineConfig } from 'tsup';

// Everything is bundled into one file so `npx vulnstack` installs nothing else.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: false,
  noExternal: [/.*/],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __vsCreateRequire } from 'node:module';\nconst require = __vsCreateRequire(import.meta.url);",
  },
});
