import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Schema = typeof schema;
/** Any Drizzle Postgres database (postgres-js in production, PGlite for tests/local dev). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface DbHandle {
  db: Db;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  migrationsFolder?: string;
}

function resolveMigrations(options?: ConnectOptions): string {
  return options?.migrationsFolder ?? process.env.VULNSTACK_MIGRATIONS_DIR ?? MIGRATIONS_FOLDER;
}

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Connects to a real Postgres server (`postgres://…`). */
export async function connectPostgres(
  url: string,
  options: { max?: number } & ConnectOptions = {},
): Promise<DbHandle> {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as Db,
    migrate: () => migrate(db, { migrationsFolder: resolveMigrations(options) }),
    close: () => client.end(),
  };
}

/**
 * In-process Postgres (WASM). `dataDir` persists to disk; omit it for an
 * in-memory database (tests).
 */
export async function connectPglite(dataDir?: string, options?: ConnectOptions): Promise<DbHandle> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as Db,
    migrate: () => migrate(db, { migrationsFolder: resolveMigrations(options) }),
    close: async () => {
      await client.waitReady;
      await client.close();
    },
  };
}

/** `postgres://…` → Postgres, `pglite:<dir>` or `pglite:memory` → PGlite. */
export async function connect(url: string, options?: ConnectOptions): Promise<DbHandle> {
  if (url.startsWith('pglite:')) {
    const dir = url.slice('pglite:'.length);
    return connectPglite(dir === 'memory' || dir === '' ? undefined : dir, options);
  }
  return connectPostgres(url, options);
}
