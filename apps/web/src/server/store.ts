import type * as DbModule from '@vulnstack/db';

/**
 * Re-exports @vulnstack/db, loaded with a native dynamic import. The package
 * finds its SQL migrations relative to its own files, so bundling it (which
 * Next does for symlinked workspace packages) would break that lookup; the
 * ignore comments keep it a plain runtime dependency instead.
 */
const db: typeof DbModule = await import(
  /* webpackIgnore: true */ /* turbopackIgnore: true */ '@vulnstack/db'
);

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
