import type { Ecosystem } from '@vulnstack/core/meta';
import type { JsonReport } from '@vulnstack/core/report';
import type { UploadFile } from './files';

export interface PackageRow {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

export type ScanBody =
  | { type: 'files'; files: { path: string; content: string }[] }
  | { type: 'packages'; packages: PackageRow[] }
  | { type: 'repo'; url: string }
  | { type: 'url'; url: string; consent: true };

/** Matches the server's message for a repo that is missing or private. */
export const isPrivateRepoError = (message: string) => /not found or private/i.test(message);

export async function postScan(body: ScanBody, signal?: AbortSignal): Promise<JsonReport> {
  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as JsonReport & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Scan failed (HTTP ${res.status})`);
  return data;
}

export const filesBody = (files: UploadFile[]): ScanBody => ({
  type: 'files',
  files: files.map(({ path, content }) => ({ path, content })),
});

export interface Suggestion {
  name: string;
  version?: string;
  description?: string;
}

export async function fetchSuggestions(
  ecosystem: Ecosystem,
  q: string,
  signal?: AbortSignal,
): Promise<Suggestion[]> {
  const res = await fetch(
    `/api/suggest?ecosystem=${encodeURIComponent(ecosystem)}&q=${encodeURIComponent(q)}`,
    signal ? { signal } : {},
  );
  if (!res.ok) return [];
  return ((await res.json()) as { suggestions: Suggestion[] }).suggestions;
}

/** JSON request that throws an Error carrying the server's message on failure. */
export async function requestJson<T = unknown>(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  return data;
}

export const postProjectScan = (projectId: string, body: ScanBody, signal?: AbortSignal) =>
  requestJson<{ scanId: string }>('POST', `/api/projects/${projectId}/scans`, body, signal);

export type TriageStatus = 'accepted' | 'false_positive';
export type TriageMap = Record<string, { status: TriageStatus; note: string | null }>;
