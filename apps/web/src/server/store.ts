import type * as DbModule from '@vulnstack/db';

/**
 * Re-exports @vulnstack/db, loaded with a native dynamic import. The package
 * finds its SQL migrations relative to its own files, so bundling it (which
 * Next does for symlinked workspace packages) would break that lookup; the
 * ignore comments keep it a plain runtime dependency instead.
 *
 * Next's file tracing cannot see this import, and some hosts (Vercel) drop the
 * pnpm workspace symlink behind the bare specifier. So when it does not resolve,
 * fall back to dist/bundle.js: a self-contained build of the package (see
 * packages/db/tsup.config.ts) shipped via outputFileTracingIncludes and found by
 * file URL relative to the working directory.
 */
const BUNDLE = 'packages/db/dist/bundle.js';

function candidates(): string[] {
  const base = `file://${process.cwd().replace(/\/+$/, '')}/`;
  const relative = ['', '../', '../../', '../../../'].map((up) => new URL(up + BUNDLE, base).href);
  return ['@vulnstack/db', ...relative, `file:///var/task/${BUNDLE}`];
}

async function load(): Promise<typeof DbModule> {
  let first: unknown;
  for (const spec of candidates()) {
    try {
      return (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ spec
      )) as typeof DbModule;
    } catch (e) {
      first ??= e;
    }
  }
  throw first;
}

const db = await load();

export const {
  asReport,
  ConflictError,
  connect,
  createApiToken,
  createProject,
  deleteProject,
  findOrCreateProject,
  getProject,
  getScan,
  getTriage,
  listApiTokens,
  listProjects,
  listScans,
  NotFoundError,
  ValidationError,
  PgCacheStore,
  recordFailedScan,
  revokeApiToken,
  saveScan,
  schema,
  setTriage,
  compareScans,
  verifyApiToken,
} = db;
