import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject, getTriage, NotFoundError, setTriage, type DbHandle } from '../src/index.js';
import { freshDb, insertUser } from './helpers.js';

let h: DbHandle;
let alice: string;
let bob: string;
let pid: string;
beforeAll(async () => {
  h = await freshDb();
  alice = await insertUser(h);
  bob = await insertUser(h);
  pid = (await createProject(h.db, alice, { name: 'p', sourceType: 'manual' })).id;
});
afterAll(() => h.close());

describe('triage', () => {
  it('sets, upserts and clears', async () => {
    await setTriage(h.db, alice, pid, 'fp1', 'accepted', '  fine for now  ');
    let t = (await getTriage(h.db, pid)).get('fp1')!;
    expect(t).toMatchObject({ fingerprint: 'fp1', status: 'accepted', note: 'fine for now' });
    expect(t.updatedAt).toBeInstanceOf(Date);

    await setTriage(h.db, alice, pid, 'fp1', 'false_positive', '   ');
    t = (await getTriage(h.db, pid)).get('fp1')!;
    expect(t.status).toBe('false_positive');
    expect(t.note).toBeNull();
    expect((await getTriage(h.db, pid)).size).toBe(1);

    await setTriage(h.db, alice, pid, 'fp2', 'accepted');
    expect((await getTriage(h.db, pid)).get('fp2')!.note).toBeNull();
    expect((await getTriage(h.db, pid)).size).toBe(2);

    await setTriage(h.db, alice, pid, 'fp1', null);
    expect([...(await getTriage(h.db, pid)).keys()]).toEqual(['fp2']);
  });

  it('caps long notes', async () => {
    await setTriage(h.db, alice, pid, 'fp3', 'accepted', 'a'.repeat(3000));
    expect((await getTriage(h.db, pid)).get('fp3')!.note).toHaveLength(2000);
  });

  it('checks ownership', async () => {
    await expect(setTriage(h.db, bob, pid, 'fp9', 'accepted')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(setTriage(h.db, bob, pid, 'fp2', null)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getTriage(h.db, pid)).has('fp2')).toBe(true);
  });
});
