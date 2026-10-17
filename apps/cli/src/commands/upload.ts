import type { FetchFn, JsonReport } from '@vulnstack/core';

export const UPLOAD_TIMEOUT_MS = 30_000;

export interface UploadParams {
  apiUrl: string;
  token: string;
  project: string;
  report: JsonReport;
  fetch: FetchFn;
}

/** Validates and normalizes the web app base URL (http/https, no trailing slash). */
export function normalizeApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid --api-url "${raw}": expected an http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`Invalid --api-url "${raw}": expected an http(s) URL`);
  return raw.replace(/\/+$/, '');
}

export async function uploadReport(params: UploadParams): Promise<{ url: string }> {
  const { apiUrl, token, project, report, fetch } = params;
  let response: Response;
  try {
    response = await fetch(`${normalizeApiUrl(apiUrl)}/api/v1/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project, report }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    // Keep the message free of request details so the token cannot leak.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`network error: ${reason}`, { cause: error });
  }

  const body = (await response.json().catch(() => undefined)) as
    { url?: unknown; error?: unknown } | undefined;
  if (!response.ok) {
    const detail = typeof body?.error === 'string' ? body.error : response.statusText;
    throw new Error(`${response.status} ${detail}`.trim());
  }
  if (typeof body?.url !== 'string') throw new Error(`${response.status} Unexpected response`);
  return { url: body.url };
}
