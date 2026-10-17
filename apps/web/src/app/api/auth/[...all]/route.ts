import { NextResponse } from 'next/server';
import { getAuth } from '@/server/auth';
import { DatabaseNotConfiguredError } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  try {
    return (await getAuth()).handler(request);
  } catch (e) {
    if (e instanceof DatabaseNotConfiguredError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }
}

export const GET = handle;
export const POST = handle;
