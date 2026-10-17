import { getProject, recordFailedScan, saveScan } from '@/server/store';
import {
  config,
  enforceRateLimit,
  userUrlLimiter,
  handle,
  HttpError,
  json,
  readJson,
  requireUser,
} from '@/server/api';
import { getGithubToken } from '@/server/github-token';
import { getDb } from '@/server/db';
import { runScan, ScanInputError } from '@/server/scan';

export const runtime = 'nodejs';
// Vercel function limit (ignored by the Docker/standalone server). Keep VULNSTACK_SCAN_TIMEOUT_MS below it.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const isTimeout = (e: unknown) =>
  e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser(request);
    const db = await getDb();
    const { id } = await params;
    await getProject(db, user.id, id);
    enforceRateLimit(user.id);
    const body = await readJson(request, config.maxUploadBytes);

    const type = (body as { type?: unknown } | null)?.type;
    if (type === 'url') enforceRateLimit(user.id, userUrlLimiter);
    const githubToken = type === 'repo' ? await getGithubToken(request.headers) : undefined;

    let report;
    try {
      report = await runScan(body, config, { githubToken });
    } catch (e) {
      if (e instanceof ScanInputError) throw new HttpError(e.message, e.status);
      const message = isTimeout(e)
        ? 'The scan took too long. Try fewer files or the CLI for large projects.'
        : 'Scan failed: an advisory source may be unavailable. Please retry.';
      console.error('project scan failed', e instanceof Error ? e.message : e);
      await recordFailedScan(db, id, 'web', message);
      throw new HttpError(message, isTimeout(e) ? 504 : 502);
    }
    const scan = await saveScan(db, id, report, 'web');
    return json({ scanId: scan.id }, 201);
  });
}
