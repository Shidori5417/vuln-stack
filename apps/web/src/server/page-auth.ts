import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { NotFoundError } from '@/server/store';
import { getCurrentUser, type CurrentUser } from './session';

/** Pages for signed-in users only: anonymous visitors go home with a sign-in prompt. */
export async function requireUserPage(): Promise<CurrentUser> {
  const user = await getCurrentUser(await headers());
  if (!user) redirect('/?signin=1');
  return user;
}

/** Runs a lookup and turns a missing/foreign record into a 404 page. */
export async function orNotFound<T>(lookup: Promise<T>): Promise<T> {
  try {
    return await lookup;
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
}
