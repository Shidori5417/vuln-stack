import { NextResponse } from 'next/server';
import { getGithubAccess } from '@/server/github-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Whether the signed-in user granted the `repo` scope. Never returns the token. */
export async function GET(request: Request) {
  const access = await getGithubAccess(request.headers);
  return NextResponse.json({ access }, { headers: { 'cache-control': 'no-store' } });
}
