import { fileURLToPath } from 'node:url';
import type { FetchFn } from '../src/net/context.js';
import type { OsvRecord } from '../src/advisories/osv.js';

export const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface FakeOsvOptions {
  /** `eco:name@version` → vuln ids */
  affected: Record<string, string[]>;
  records: OsvRecord[];
  /** npm registry abbreviated metadata by package name */
  registry?: Record<string, { versions: string[]; latest?: string }>;
}

/** A fetch that answers OSV querybatch / vulns and the npm registry from memory. */
export function fakeOsv(options: FakeOsvOptions) {
  const calls: { url: string; body?: unknown }[] = [];
  const byId = new Map(options.records.map((r) => [r.id, r]));

  const fetch: FetchFn = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });

    if (url.endsWith('/v1/querybatch')) {
      const results = (
        body.queries as { package: { ecosystem: string; name: string }; version: string }[]
      ).map((q) => {
        const ids = options.affected[`${q.package.ecosystem}:${q.package.name}@${q.version}`] ?? [];
        return ids.length
          ? { vulns: ids.map((id) => ({ id, modified: '2026-01-01T00:00:00Z' })) }
          : {};
      });
      return json({ results });
    }
    const vuln = /\/v1\/vulns\/(.+)$/.exec(url);
    if (vuln) {
      const record = byId.get(decodeURIComponent(vuln[1]!));
      return record ? json(record) : json({ code: 5, message: 'Bug not found' }, 404);
    }
    const reg = /registry\.npmjs\.org\/(.+)$/.exec(url);
    if (reg) {
      const name = decodeURIComponent(reg[1]!);
      const pkg = options.registry?.[name];
      if (!pkg) return json({ error: 'Not found' }, 404);
      return json({
        'dist-tags': { latest: pkg.latest ?? pkg.versions.at(-1) },
        versions: Object.fromEntries(pkg.versions.map((v) => [v, {}])),
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return { fetch, calls };
}

/** Minimal GHSA-style OSV record for one npm package with a single range. */
export function ghsa(
  id: string,
  pkg: string,
  range: { introduced?: string; fixed?: string; last_affected?: string },
  opts: { cve?: string; vector?: string; label?: string; summary?: string } = {},
): OsvRecord {
  const events: Record<string, string>[] = [{ introduced: range.introduced ?? '0' }];
  if (range.fixed) events.push({ fixed: range.fixed });
  if (range.last_affected) events.push({ last_affected: range.last_affected });
  return {
    id,
    aliases: opts.cve ? [opts.cve] : [],
    summary: opts.summary ?? `${pkg} issue ${id}`,
    modified: '2026-01-01T00:00:00Z',
    published: '2024-01-01T00:00:00Z',
    ...(opts.vector
      ? {
          severity: [
            { type: opts.vector.startsWith('CVSS:4') ? 'CVSS_V4' : 'CVSS_V3', score: opts.vector },
          ],
        }
      : {}),
    affected: [
      {
        package: { ecosystem: 'npm', name: pkg },
        ranges: [{ type: 'SEMVER', events }],
      },
    ],
    references: [{ type: 'ADVISORY', url: `https://github.com/advisories/${id}` }],
    database_specific: { severity: opts.label ?? 'MODERATE', cwe_ids: ['CWE-79'] },
  };
}

export const CRITICAL_VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'; // 9.8
export const HIGH_VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H'; // 7.5
export const LOW_VECTOR = 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N'; // 3.1
