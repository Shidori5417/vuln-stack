import { getAuth } from './auth';

const hasSessionCookie = (headers: Headers) =>
  (headers.get('cookie') ?? '').includes('session_token');

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
  } catch {
    return undefined;
  }
}
