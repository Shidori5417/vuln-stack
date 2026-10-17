import { schema } from '@/server/store';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getDb } from './db';

/** Whether GitHub sign-in can work; the UI explains the missing setup otherwise. */
export const isLoginConfigured = (env: Record<string, string | undefined> = process.env) =>
  Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

async function create() {
  const db = await getDb();
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, BETTER_AUTH_SECRET, BETTER_AUTH_URL } =
    process.env;
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    ...(BETTER_AUTH_SECRET ? { secret: BETTER_AUTH_SECRET } : {}),
    ...(BETTER_AUTH_URL ? { baseURL: BETTER_AUTH_URL } : {}),
    // GitHub access/refresh tokens are encrypted at rest.
    account: {
      encryptOAuthTokens: true,
      // Re-authorizing GitHub with the optional `repo` scope (linkSocial) hits the
      // already-linked account: its token is replaced and the scope merged in.
      accountLinking: { enabled: true, trustedProviders: ['github'] },
    },
    socialProviders:
      GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: GITHUB_CLIENT_ID,
              clientSecret: GITHUB_CLIENT_SECRET,
              scope: ['read:user', 'user:email'],
            },
          }
        : {},
  });
}

let instance: ReturnType<typeof create> | undefined;

/** Created lazily, after the database is ready. */
export function getAuth() {
  instance ??= create().catch((e: unknown) => {
    instance = undefined;
    throw e;
  });
  return instance;
}
