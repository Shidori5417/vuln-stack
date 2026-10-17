import { githubAccessFrom, type GithubAccess } from '@/lib/github-access';
import { getAuth } from './auth';

const hasSessionCookie = (headers: Headers) =>
  (headers.get('cookie') ?? '').includes('session_token');

/** One-line, non-sensitive warning (error name only; messages could echo request data). */
function warn(what: string, e: unknown) {
  console.warn(`github-token: ${what} failed (${e instanceof Error ? e.name : 'unknown error'})`);
}

/**
 * The signed-in user's GitHub OAuth access token (decrypted by Better Auth), or
 * undefined for anonymous visitors / users without a linked GitHub account.
 * Server-side only: never put the result in a response or a log line.
 */
export async function getGithubToken(headers: Headers): Promise<string | undefined> {
  if (!hasSessionCookie(headers)) return undefined;
  try {
    const { api } = await getAuth();
    const accounts = await api.listUserAccounts({ headers });
    const github = accounts.find((a) => a.providerId === 'github');
    if (!github) return undefined;
    const { accessToken } = await api.getAccessToken({ body: { accountId: github.id }, headers });
    return accessToken || undefined;
  } catch (e) {
    warn('token lookup', e);
    return undefined;
  }
}

/** Whether the stored GitHub grant includes `repo`. Reads the stored scope only. */
export async function getGithubAccess(headers: Headers): Promise<GithubAccess> {
  if (!hasSessionCookie(headers)) return 'signed-out';
  try {
    const { api } = await getAuth();
    const accounts = await api.listUserAccounts({ headers });
    return githubAccessFrom(accounts.find((a) => a.providerId === 'github'));
  } catch (e) {
    warn('access lookup', e);
    return 'signed-out';
  }
}
