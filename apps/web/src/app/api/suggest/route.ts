import { NextResponse } from 'next/server';
import { ECOSYSTEMS, type Ecosystem } from '@vulnstack/core';
import { readConfig } from '@/server/config';
import { clientKey, RateLimiter } from '@/server/rate-limit';
import { suggest } from '@/server/suggest';

export const runtime = 'nodejs';

const config = readConfig();
// Typing triggers many lookups; allow more than scans.
const limiter = new RateLimiter(config.scansPerMinute * 12, 60_000);

export async function GET(request: Request) {
  if (limiter.hit(clientKey(request.headers, config.trustProxy)) > 0) {
    return NextResponse.json({ suggestions: [] }, { status: 429 });
  }
  const url = new URL(request.url);
  const ecosystem = url.searchParams.get('ecosystem') as Ecosystem;
  const q = url.searchParams.get('q') ?? '';
  if (!ECOSYSTEMS.includes(ecosystem))
    return NextResponse.json({ error: 'Unknown ecosystem' }, { status: 400 });
  return NextResponse.json(
    { suggestions: await suggest(ecosystem, q) },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}
