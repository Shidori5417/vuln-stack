import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
}));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vulnstack-db-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PGlite persistence', () => {
  it('a created project is readable after the handle is closed and reopened', async () => {
    const { connect, createProject, getProject, schema } = await import('@/server/store');
    const url = `pglite:${join(dir, 'data')}`;
    const h1 = await connect(url);
    await h1.migrate();
    const { db: db1 } = h1;
    await db1
      .insert(schema.user)
      .values({ id: 'u1', name: 'U', email: 'u@example.com', emailVerified: true });
    const created = await createProject(db1, 'u1', { name: 'p', sourceType: 'manual' });
    await h1.close();

    const h2 = await connect(url);
    await h2.migrate();
    const found = await getProject(h2.db, 'u1', created.id);
    expect(found.id).toBe(created.id);
    await h2.close();
  });
});

describe('getDb singleton', () => {
  it('is shared across module re-evaluation (HMR / separate bundles)', async () => {
    vi.stubEnv('DATABASE_URL', '');
    delete process.env.DATABASE_URL;
    const g = globalThis as { __vulnstackDb?: unknown };
    const saved = g.__vulnstackDb;
    g.__vulnstackDb = undefined;
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const a = await import('@/server/db');
      const first = await a.getDb();
      vi.resetModules();
      const b = await import('@/server/db');
      expect(b).not.toBe(a);
      expect(await b.getDb()).toBe(first);
    } finally {
      process.chdir(prev);
      g.__vulnstackDb = saved;
      vi.unstubAllEnvs();
    }
  });
});

describe('orNotFound', () => {
  it('maps only NotFoundError to notFound() and rethrows other errors', async () => {
    const { orNotFound } = await import('@/server/page-auth');
    const { NotFoundError } = await import('@/server/store');
    await expect(orNotFound(Promise.reject(new NotFoundError('x')))).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    await expect(orNotFound(Promise.reject(new Error('db down')))).rejects.toThrow('db down');
  });
});
