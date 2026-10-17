import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db } from '@vulnstack/db';
import { connect } from './store';

const LOCAL_FALLBACK = 'pglite:.data/pglite';

// Next dev re-evaluates modules per bundle (route handlers vs. server components)
// and on every HMR recompile. A module-level variable would then open several
// PGlite instances on the same data dir, so the handle lives on globalThis.
const globalForDb = globalThis as typeof globalThis & { __vulnstackDb?: Promise<Db> };

/** True when a real database URL is configured (as opposed to the local PGlite fallback). */
export const hasDatabaseUrl = () => Boolean(process.env.DATABASE_URL);

async function open(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn(`DATABASE_URL is not set; using local PGlite at ${LOCAL_FALLBACK} (dev only).`);
  }
  const target = url ?? LOCAL_FALLBACK;
  // PGlite creates its data directory but not the parents above it.
  if (target.startsWith('pglite:') && !target.endsWith(':memory')) {
    mkdirSync(dirname(target.slice('pglite:'.length)), { recursive: true });
  }
  const handle = await connect(target);
  await handle.migrate();
  return handle.db;
}

/** Lazy singleton: connects and migrates on first use, never at build time. */
export function getDb(): Promise<Db> {
  globalForDb.__vulnstackDb ??= open().catch((e: unknown) => {
    globalForDb.__vulnstackDb = undefined; // let the next request retry instead of caching the failure
    throw e;
  });
  return globalForDb.__vulnstackDb;
}

/** Test hook: use an already-migrated database (or pass undefined to reset). */
export function setDbForTesting(db: Db | undefined): void {
  globalForDb.__vulnstackDb = db ? Promise.resolve(db) : undefined;
}
