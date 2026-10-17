import { NextResponse } from 'next/server';
import { getGithubToken } from '@/server/github-token';
import { readConfig } from '@/server/config';
import { clientKey, RateLimiter } from '@/server/rate-limit';
import { runScan, ScanInputError } from '@/server/scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const config = readConfig();
const limiter = new RateLimiter(config.scansPerMinute, 60_000);

// URL scans make outbound requests to third-party sites: a third of the normal budget.
const urlLimiter = new RateLimiter(Math.max(1, Math.ceil(config.scansPerMinute / 3)), 60_000);

const error = (message: string, status: number, headers: Record<string, string> = {}) =>
  NextResponse.json({ error: message }, { status, headers });

export async function POST(request: Request) {
  const retryAfter = limiter.hit(clientKey(request.headers, config.trustProxy));
  if (retryAfter > 0) {
    return error(`Too many scans. Try again in ${retryAfter}s.`, 429, {
      'retry-after': String(retryAfter),
    });
  }

  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > config.maxUploadBytes) return error('Upload too large', 413);

  // Read the body ourselves so a missing/lying Content-Length can't bypass the limit.
  const raw = await request.text();
  if (Buffer.byteLength(raw) > config.maxUploadBytes) return error('Upload too large', 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error('Request body must be JSON', 400);
  }

  const type = (body as { type?: unknown } | null)?.type;
  if (type === 'url') {
    const wait = urlLimiter.hit(clientKey(request.headers, config.trustProxy));
    if (wait > 0) {
      return error(`Too many website scans. Try again in ${wait}s.`, 429, {
        'retry-after': String(wait),
      });
    }
  }

  try {
    const githubToken = type === 'repo' ? await getGithubToken(request.headers) : undefined;
    const report = await runScan(body, config, { githubToken });
    return NextResponse.json(report, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    if (e instanceof ScanInputError) return error(e.message, e.status);
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return error('The scan took too long. Try fewer files or the CLI for large projects.', 504);
    }
    console.error('scan failed', e);
    return error('Scan failed: an advisory source may be unavailable. Please retry.', 502);
  }
}
