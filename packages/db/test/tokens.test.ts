import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createApiToken,
  hashToken,
  listApiTokens,
  NotFoundError,
  revokeApiToken,
  schema,
  TOKEN_PREFIX,
  verifyApiToken,
  type DbHandle,
} from '../src/index.js';
import { freshDb, insertUser } from './helpers.js';

let h: DbHandle;
let alice: string;
let bob: string;
beforeAll(async () => {
  h = await freshDb();
  alice = await insertUser(h);
  bob = await insertUser(h);
});
afterAll(() => h.close());

describe('api tokens', () => {
  it('creates a vs_ token and stores only its hash', async () => {
    const { token, record } = await createApiToken(h.db, alice, '  ci  ');
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(record.name).toBe('ci');
    expect(record.prefix).toBe(token.slice(0, 10));
    expect(record.expiresAt).toBeNull();
    expect('tokenHash' in record).toBe(false);
    const [row] = await h.db
      .select()
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.id, record.id));
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('defaults empty names and truncates long ones', async () => {
    expect((await createApiToken(h.db, alice, '  ')).record.name).toBe('CLI token');
    expect((await createApiToken(h.db, alice, 'x'.repeat(300))).record.name).toHaveLength(100);
  });

  it('lists without hash and without revoked tokens', async () => {
    const u = await insertUser(h);
    const a = await createApiToken(h.db, u, 'a');
    const b = await createApiToken(h.db, u, 'b');
    await revokeApiToken(h.db, u, a.record.id);
    const list = await listApiTokens(h.db, u);
    expect(list.map((t) => t.id)).toEqual([b.record.id]);
    expect(list.every((t) => !('tokenHash' in t))).toBe(true);
    expect(await listApiTokens(h.db, bob)).toEqual([]);
  });

  it('verifies valid tokens and records lastUsedAt', async () => {
    const { token, record } = await createApiToken(h.db, alice, 'v');
    expect(record.lastUsedAt).toBeNull();
    const now = new Date('2030-01-01T00:00:00Z');
    expect(await verifyApiToken(h.db, token, now)).toBe(alice);
    const [row] = await h.db
      .select()
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.id, record.id));
    expect(row!.lastUsedAt?.toISOString()).toBe(now.toISOString());
    expect(await verifyApiToken(h.db, token)).toBe(alice);
  });

  it('rejects bad prefix, unknown, oversized, revoked and expired tokens', async () => {
    const { token, record } = await createApiToken(h.db, alice, 'r');
    expect(await verifyApiToken(h.db, token.replace('vs_', 'xx_'))).toBeNull();
    expect(await verifyApiToken(h.db, 'vs_unknown')).toBeNull();
    expect(await verifyApiToken(h.db, `vs_${'a'.repeat(300)}`)).toBeNull();
    await revokeApiToken(h.db, alice, record.id);
    expect(await verifyApiToken(h.db, token)).toBeNull();

    const exp = await createApiToken(h.db, alice, 'e', { expiresInDays: 1 });
    expect(exp.record.expiresAt).toBeInstanceOf(Date);
    expect(await verifyApiToken(h.db, exp.token)).toBe(alice);
    const later = new Date(Date.now() + 2 * 86_400_000);
    expect(await verifyApiToken(h.db, exp.token, later)).toBeNull();
  });

  it('revoke reports missing tokens', async () => {
    const { record } = await createApiToken(h.db, alice, 'x');
    await expect(revokeApiToken(h.db, bob, record.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(revokeApiToken(h.db, alice, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
    await revokeApiToken(h.db, alice, record.id);
    await expect(revokeApiToken(h.db, alice, record.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
