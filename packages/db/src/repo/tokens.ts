import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client.js';
import { apiTokens } from '../schema.js';
import { NotFoundError } from './projects.js';

export const TOKEN_PREFIX = 'vs_';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export type ApiToken = Omit<typeof apiTokens.$inferSelect, 'tokenHash'>;

const withoutHash = ({ tokenHash: _hash, ...rest }: typeof apiTokens.$inferSelect): ApiToken =>
  rest;

/** Creates a token. The plain value is returned once and never stored. */
export async function createApiToken(
  db: Db,
  userId: string,
  name: string,
  options: { expiresInDays?: number } = {},
): Promise<{ token: string; record: ApiToken }> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = options.expiresInDays
    ? new Date(Date.now() + options.expiresInDays * 86_400_000)
    : null;
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId,
      name: name.trim().slice(0, 100) || 'CLI token',
      tokenHash: hashToken(token),
      prefix: token.slice(0, 10),
      expiresAt,
    })
    .returning();
  return { token, record: withoutHash(row!) };
}

export async function listApiTokens(db: Db, userId: string): Promise<ApiToken[]> {
  const rows = await db.query.apiTokens.findMany({
    where: and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)),
    orderBy: desc(apiTokens.createdAt),
  });
  return rows.map(withoutHash);
}

export async function revokeApiToken(db: Db, userId: string, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError('Token');
  const updated = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  if (updated.length === 0) throw new NotFoundError('Token');
}

/** Returns the owner's user id for a valid, unexpired, unrevoked token. */
export async function verifyApiToken(
  db: Db,
  token: string,
  now = new Date(),
): Promise<string | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const row = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.tokenHash, hashToken(token)),
  });
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) return null;
  await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id));
  return row.userId;
}
