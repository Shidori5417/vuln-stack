import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, MIGRATIONS_FOLDER, type DbHandle } from '../src/index.js';
import { freshDb } from './helpers.js';
import { sql } from 'drizzle-orm';

describe('migrations and connect', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await freshDb();
  });
  afterAll(() => h.close());

  it('creates all tables', async () => {
    const res = await h.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = ((res as unknown as { rows: unknown[] }).rows as { table_name: string }[]).map(
      (r) => r.table_name,
    );
    for (const t of [
      'user',
      'session',
      'account',
      'verification',
      'projects',
      'scans',
      'scan_dependencies',
      'vulnerabilities',
      'findings',
      'finding_triage',
      'vuln_cache',
      'api_tokens',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('finds the migrations folder', () => {
    expect(existsSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'))).toBe(true);
  });

  it('resolves to <package>/drizzle, the same place dist/index.js uses', () => {
    const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
    expect(MIGRATIONS_FOLDER).toBe(join(pkgRoot, 'drizzle'));
  });

  it('connect() understands pglite:memory and pglite:<dir>', async () => {
    const mem = await connect('pglite:memory');
    await mem.migrate();
    await mem.close();
    const empty = await connect('pglite:');
    await empty.close();
  });

  it('connect() builds a lazy postgres handle without touching the network', async () => {
    const pg = await connect('postgres://u:p@127.0.0.1:1/none');
    expect(typeof pg.migrate).toBe('function');
    await pg.close();
  });
});
