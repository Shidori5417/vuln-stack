import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ConflictError,
  createProject,
  deleteProject,
  findOrCreateProject,
  getProject,
  listProjects,
  NotFoundError,
  saveScan,
  schema,
  ValidationError,
  type DbHandle,
} from '../src/index.js';
import { freshDb, insertUser, makeReport } from './helpers.js';

let h: DbHandle;
let alice: string;
let bob: string;
beforeAll(async () => {
  h = await freshDb();
  alice = await insertUser(h);
  bob = await insertUser(h);
});
afterAll(() => h.close());

describe('projects', () => {
  it('createProject trims, rejects empty, detects duplicates per owner', async () => {
    const p = await createProject(h.db, alice, { name: '  web  ', sourceType: 'manual' });
    expect(p.name).toBe('web');
    expect(p.sourceRef).toBeNull();
    await expect(createProject(h.db, alice, { name: '   ', sourceType: 'manual' })).rejects.toThrow(
      'required',
    );
    await expect(
      createProject(h.db, alice, { name: 'web', sourceType: 'repo' }),
    ).rejects.toBeInstanceOf(ConflictError);
    const other = await createProject(h.db, bob, {
      name: 'web',
      sourceType: 'repo',
      sourceRef: 'x',
    });
    expect(other.ownerId).toBe(bob);
    expect(other.sourceRef).toBe('x');
  });

  it('getProject is owner scoped and validates ids', async () => {
    const p = await createProject(h.db, alice, { name: 'scoped', sourceType: 'cli' });
    expect((await getProject(h.db, alice, p.id)).id).toBe(p.id);
    await expect(getProject(h.db, bob, p.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProject(h.db, alice, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProject(h.db, alice, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      'Project not found',
    );
  });

  it('findOrCreateProject reuses existing projects', async () => {
    const a = await findOrCreateProject(h.db, alice, ' reuse ', 'cli');
    const b = await findOrCreateProject(h.db, alice, 'reuse', 'cli', 'ref');
    expect(b.id).toBe(a.id);
    const c = await findOrCreateProject(h.db, alice, 'fresh', 'url', 'https://x.test');
    expect(c.sourceRef).toBe('https://x.test');
  });

  it('listProjects populates latestScan and orders by updatedAt desc', async () => {
    const carol = await insertUser(h);
    const first = await createProject(h.db, carol, { name: 'first', sourceType: 'manual' });
    const second = await createProject(h.db, carol, { name: 'second', sourceType: 'manual' });
    expect((await listProjects(h.db, carol)).map((p) => p.name)).toEqual(['second', 'first']);
    // updatedAt is bumped by saveScan, so first becomes the most recent.
    await new Promise((r) => setTimeout(r, 5));
    const report = await makeReport('lodash@4.17.15');
    await saveScan(h.db, first.id, report, 'web');
    await new Promise((r) => setTimeout(r, 5));
    const latest = await saveScan(h.db, first.id, report, 'cli');
    const list = await listProjects(h.db, carol);
    expect(list.map((p) => p.name)).toEqual(['first', 'second']);
    expect(list[0]!.latestScan?.id).toBe(latest.id);
    expect(list[1]!.id).toBe(second.id);
    expect(list[1]!.latestScan).toBeNull();
  });

  it('deleteProject cascades scans and findings', async () => {
    const p = await createProject(h.db, alice, { name: 'doomed', sourceType: 'manual' });
    const scan = await saveScan(h.db, p.id, await makeReport(), 'web');
    await expect(deleteProject(h.db, bob, p.id)).rejects.toBeInstanceOf(NotFoundError);
    await deleteProject(h.db, alice, p.id);
    expect(await h.db.select().from(schema.scans).where(eq(schema.scans.id, scan.id))).toHaveLength(
      0,
    );
    expect(
      await h.db.select().from(schema.findings).where(eq(schema.findings.scanId, scan.id)),
    ).toHaveLength(0);
    expect(
      await h.db
        .select()
        .from(schema.scanDependencies)
        .where(eq(schema.scanDependencies.scanId, scan.id)),
    ).toHaveLength(0);
  });
});

describe('validation and races', () => {
  it('rejects empty names with ValidationError', async () => {
    await expect(
      createProject(h.db, alice, { name: '  ', sourceType: 'manual' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('findOrCreateProject is race-safe', async () => {
    const rows = await Promise.all(
      Array.from({ length: 6 }, () => findOrCreateProject(h.db, alice, 'racy', 'manual')),
    );
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
  });
});
