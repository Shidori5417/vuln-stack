import { getAuth } from './auth';

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

/** Better Auth's cookie is named `[__Secure-]better-auth.session_token`. */
const hasSessionCookie = (headers: Headers) =>
  (headers.get('cookie') ?? '').includes('session_token');

/** Resolves the signed-in user, or null. Never touches the database for anonymous visitors. */
export async function getCurrentUser(headers: Headers): Promise<CurrentUser | null> {
  if (!hasSessionCookie(headers)) return null;
  const session = await (await getAuth()).api.getSession({ headers });
  if (!session) return null;
  const { id, name, email, image } = session.user;
  return { id, name, email, image: image ?? null };
}
