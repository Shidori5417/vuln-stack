import { randomUUID } from 'node:crypto';
import { scanManual, toJsonReport, type FetchFn, type OsvRecord } from '@vulnstack/core';
import type { JsonReport } from '@vulnstack/core/report';
import { connectPglite, schema, type DbHandle } from '../src/index.js';

export const CRITICAL_VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
export const LOW_VECTOR = 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N';

export async function freshDb(): Promise<DbHandle> {
  const handle = await connectPglite();
  await handle.migrate();
  return handle;
}

export async function insertUser(handle: DbHandle, id = `u-${randomUUID()}`): Promise<string> {
  await handle.db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
  return id;
}

export function ghsa(
  id: string,
  pkg: string,
  range: { introduced?: string; fixed?: string },
  opts: { vector?: string; label?: string; summary?: string } = {},
): OsvRecord {
  const events: Record<string, string>[] = [{ introduced: range.introduced ?? '0' }];
  if (range.fixed) events.push({ fixed: range.fixed });
  return {
    id,
    aliases: [],
    summary: opts.summary ?? `${pkg} issue ${id}`,
    modified: '2026-01-01T00:00:00Z',
    published: '2024-01-01T00:00:00Z',
    ...(opts.vector ? { severity: [{ type: 'CVSS_V3', score: opts.vector }] } : {}),
    affected: [{ package: { ecosystem: 'npm', name: pkg }, ranges: [{ type: 'SEMVER', events }] }],
    references: [{ type: 'ADVISORY', url: `https://github.com/advisories/${id}` }],
    database_specific: { severity: opts.label ?? 'MODERATE', cwe_ids: ['CWE-79'] },
  } as OsvRecord;
}

export function fakeOsv(affected: Record<string, string[]>, records: OsvRecord[]): FetchFn {
  const byId = new Map(records.map((r) => [r.id, r]));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  return async (url, init) => {
    if (url.endsWith('/v1/querybatch')) {
      const body = JSON.parse(String(init?.body)) as {
        queries: { package: { ecosystem: string; name: string }; version: string }[];
      };
      return json({
        results: body.queries.map((q) => {
          const ids = affected[`${q.package.ecosystem}:${q.package.name}@${q.version}`] ?? [];
          return ids.length
            ? { vulns: ids.map((id) => ({ id, modified: '2026-01-01T00:00:00Z' })) }
            : {};
        }),
      });
    }
    const m = /\/v1\/vulns\/(.+)$/.exec(url);
    if (m) {
      const rec = byId.get(decodeURIComponent(m[1]!));
      return rec ? json(rec) : json({ code: 5 }, 404);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

export const RECORDS = [
  ghsa(
    'GHSA-aaaa-aaaa-aaaa',
    'lodash',
    { fixed: '4.17.21' },
    { vector: CRITICAL_VECTOR, label: 'CRITICAL' },
  ),
  ghsa('GHSA-bbbb-bbbb-bbbb', 'lodash', { fixed: '4.17.19' }, { vector: LOW_VECTOR, label: 'LOW' }),
  ghsa('GHSA-cccc-cccc-cccc', 'express', { fixed: '4.18.0' }, { label: 'HIGH' }),
];

const AFFECTED = {
  'npm:lodash@4.17.15': ['GHSA-aaaa-aaaa-aaaa', 'GHSA-bbbb-bbbb-bbbb'],
  'npm:express@4.17.1': ['GHSA-cccc-cccc-cccc'],
};

/** Real JsonReport via core's manual scan; `records` overrides advisory data. */
export async function makeReport(
  text = 'lodash@4.17.15, express@4.17.1, react@18.2.0',
  records: OsvRecord[] = RECORDS,
): Promise<JsonReport> {
  const result = await scanManual(text, { fetch: fakeOsv(AFFECTED, records) });
  return toJsonReport(result);
}
