import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db } from '@vulnstack/db';
import { connect } from './store';

const LOCAL_FALLBACK = 'pglite:.data/pglite';

let ready: Promise<Db> | undefined;

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
  ready ??= open().catch((e: unknown) => {
    ready = undefined; // let the next request retry instead of caching the failure
    throw e;
  });
  return ready;
}

/** Test hook: use an already-migrated database (or pass undefined to reset). */
export function setDbForTesting(db: Db | undefined): void {
  ready = db ? Promise.resolve(db) : undefined;
}
