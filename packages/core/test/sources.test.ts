import { describe, expect, it, vi } from 'vitest';
import { GhsaClient, ghsaNodesToRecords, ghsaRangeToEvents } from '../src/advisories/ghsa.js';
import { NvdClient, pickNvdCvss } from '../src/advisories/nvd.js';
import { MemoryCache } from '../src/cache/memory.js';
import { SlidingWindowLimiter, type Clock } from '../src/net/rate-limit.js';
import { recordAffects } from '../src/remediation.js';
import { npmVersioning } from '../src/ecosystems/npm/versioning.js';
import { normalizePypiName, pypiVersioning } from '../src/ecosystems/pypi/versioning.js';
import { scanManual } from '../src/scan.js';
import type { FetchFn, NetContext } from '../src/net/context.js';
import { CRITICAL_VECTOR, fakeOsv, ghsa, json, LOW_VECTOR } from './helpers.js';

function fakeClock(start = 0): Clock & { t: number } {
  const c = {
    t: start,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms;
    },
  };
  return c;
}

const net = (fetch: FetchFn): NetContext => ({
  fetch,
  cache: new MemoryCache(),
  userAgent: 'test',
});

const ghsaNode = (
  id: string,
  pkg: string,
  range: string,
  patched: string | null,
  extra: Record<string, unknown> = {},
) => ({
  vulnerableVersionRange: range,
  firstPatchedVersion: patched ? { identifier: patched } : null,
  package: { name: pkg, ecosystem: 'NPM' },
  advisory: {
    ghsaId: id,
    summary: `${pkg} advisory`,
    description: 'Long description',
    severity: 'HIGH',
    publishedAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-02-01T00:00:00Z',
    withdrawnAt: null,
    permalink: `https://github.com/advisories/${id}`,
    identifiers: [
      { type: 'GHSA', value: id },
      { type: 'CVE', value: `CVE-${id.slice(5)}` },
    ],
    references: [{ url: 'https://example.com/fix' }],
    cvssSeverities: { cvssV3: { vectorString: CRITICAL_VECTOR }, cvssV4: { vectorString: null } },
    cwes: { nodes: [{ cweId: 'CWE-1321' }] },
    ...extra,
  },
});

describe('SlidingWindowLimiter', () => {
  it('allows `limit` calls per window and waits for the next slot', async () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowLimiter(2, 1000, clock);
    expect(await limiter.acquire()).toBe(true);
    expect(await limiter.acquire()).toBe(true);
    expect(clock.t).toBe(0);
    expect(await limiter.acquire()).toBe(true);
    expect(clock.t).toBe(1000);
  });

  it('gives up when the next slot is past the deadline', async () => {
    const clock = fakeClock();
    const limiter = new SlidingWindowLimiter(1, 1000, clock);
    await limiter.acquire();
    expect(await limiter.acquire(500)).toBe(false);
    expect(clock.t).toBe(0);
  });
});

describe('GHSA conversion', () => {
  it('turns GHSA ranges into OSV events', () => {
    expect(ghsaRangeToEvents('< 4.17.21')).toEqual({
      events: [{ introduced: '0' }, { fixed: '4.17.21' }],
      versions: [],
    });
    expect(ghsaRangeToEvents('>= 2.0.0, < 2.1.3')).toEqual({
      events: [{ introduced: '2.0.0' }, { fixed: '2.1.3' }],
      versions: [],
    });
    expect(ghsaRangeToEvents('<= 1.2.3', '1.2.4')).toEqual({
      events: [{ introduced: '0' }, { last_affected: '1.2.3' }, { fixed: '1.2.4' }],
      versions: [],
    });
    expect(ghsaRangeToEvents('= 1.5.0')).toEqual({ events: [], versions: ['1.5.0'] });
    expect(ghsaRangeToEvents('> 1.0, garbage')).toEqual({
      events: [{ introduced: '1.0' }],
      versions: [],
    });
  });

  it('groups nodes per advisory and carries scores, ids and references', () => {
    const records = ghsaNodesToRecords(
      [
        ghsaNode('GHSA-aaaa', 'lodash', '< 4.17.19', '4.17.19'),
        ghsaNode('GHSA-aaaa', 'lodash', '>= 5.0.0, < 5.0.1', '5.0.1'),
        ghsaNode('GHSA-bbbb', 'lodash', '= 3.0.0', null, {
          cvssSeverities: null,
          description: null,
          cwes: undefined,
        }),
      ],
      'npm',
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: 'GHSA-aaaa',
      aliases: ['CVE-aaaa'],
      severity: [{ type: 'CVSS_V3', score: CRITICAL_VECTOR }],
      database_specific: { severity: 'HIGH', cwe_ids: ['CWE-1321'] },
    });
    expect(records[0]!.affected).toHaveLength(2);
    expect(records[0]!.references![0]).toEqual({
      type: 'ADVISORY',
      url: 'https://github.com/advisories/GHSA-aaaa',
    });
    expect(records[1]).toMatchObject({
      severity: [],
      affected: [{ versions: ['3.0.0'], ranges: [] }],
    });
    expect(records[1]!.details).toBeUndefined();
  });

  it('checks whether a record affects a version', () => {
    const [r] = ghsaNodesToRecords([ghsaNode('GHSA-a', 'lodash', '< 4.17.19', '4.17.19')], 'npm');
    expect(recordAffects(r!.affected!, 'npm', 'lodash', '4.17.15', npmVersioning)).toBe(true);
    expect(recordAffects(r!.affected!, 'npm', 'lodash', '4.17.19', npmVersioning)).toBe(false);
    expect(recordAffects(r!.affected!, 'npm', 'other', '1.0.0', npmVersioning)).toBe(false);
    const py = [{ package: { ecosystem: 'PyPI', name: 'Django' }, versions: ['4.1'], ranges: [] }];
    expect(recordAffects(py, 'PyPI', 'django', '4.1', pypiVersioning, normalizePypiName)).toBe(
      true,
    );
    expect(recordAffects([{}], 'npm', 'x', '1', npmVersioning)).toBe(false);
  });
});

describe('GhsaClient', () => {
  it('batches packages as aliased GraphQL fields, paginates and caches', async () => {
    const bodies: string[] = [];
    const fetch = vi.fn<FetchFn>(async (_url, init) => {
      const query = JSON.parse(String(init!.body)).query as string;
      bodies.push(query);
      expect((init!.headers as Record<string, string>).authorization).toBe('bearer tkn');
      if (query.includes('after:')) {
        return json({
          data: {
            p0: {
              nodes: [ghsaNode('GHSA-page2', 'lodash', '< 1', '1')],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return json({
        data: {
          p0: {
            nodes: [ghsaNode('GHSA-page1', 'lodash', '< 1', '1')],
            pageInfo: { hasNextPage: true, endCursor: 'c1' },
          },
          p1: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      });
    });
    const client = new GhsaClient(net(fetch), 'tkn');
    const result = await client.query([
      { ecosystem: 'npm', name: 'lodash' },
      { ecosystem: 'PyPI', name: 'django' },
      { ecosystem: 'npm', name: 'lodash' },
    ]);
    expect(result.get('ghsa:npm:lodash')!.map((r) => r.id)).toEqual(['GHSA-page1', 'GHSA-page2']);
    expect(result.get('ghsa:PyPI:django')).toEqual([]);
    expect(bodies[0]).toContain(
      'p0: securityVulnerabilities(ecosystem: NPM, package: "lodash", first: 100)',
    );
    expect(bodies[0]).toContain('p1: securityVulnerabilities(ecosystem: PIP, package: "django"');
    expect(bodies[1]).toContain('after: "c1"');
    await client.query([{ ecosystem: 'npm', name: 'lodash' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails on GraphQL errors without data', async () => {
    const client = new GhsaClient(
      net(async () => json({ errors: [{ message: 'Bad credentials' }] })),
      'x',
    );
    await expect(client.query([{ ecosystem: 'npm', name: 'a' }])).rejects.toThrow(
      /Bad credentials/,
    );
  });
});

describe('NVD', () => {
  const nvdBody = (cve: string, metrics: Record<string, unknown>) =>
    json({
      vulnerabilities: [
        {
          cve: {
            id: cve,
            descriptions: [
              { lang: 'es', value: 'x' },
              { lang: 'en', value: `${cve} description` },
            ],
            metrics,
          },
        },
      ],
    });

  it('prefers primary v3.1, then v3.0, then v4.0 metrics', () => {
    expect(
      pickNvdCvss({
        cvssMetricV40: [
          {
            type: 'Primary',
            cvssData: {
              vectorString: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
            },
          },
        ],
        cvssMetricV31: [
          { type: 'Secondary', cvssData: { vectorString: LOW_VECTOR } },
          { type: 'Primary', cvssData: { vectorString: CRITICAL_VECTOR } },
        ],
      }),
    ).toMatchObject({ score: 9.8, source: 'nvd', version: '3.1' });
    expect(
      pickNvdCvss({
        cvssMetricV40: [
          {
            cvssData: {
              vectorString: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
            },
          },
        ],
      }),
    ).toMatchObject({ version: '4.0' });
    expect(
      pickNvdCvss({ cvssMetricV2: [{ cvssData: { vectorString: 'AV:N/AC:L/Au:N/C:P/I:P/A:P' } }] }),
    ).toBeUndefined();
    expect(pickNvdCvss(undefined)).toBeUndefined();
  });

  it('throttles, respects the budget and caches results', async () => {
    const clock = fakeClock();
    const fetch = vi.fn<FetchFn>(async (url) => {
      const cve = new URL(url).searchParams.get('cveId')!;
      return nvdBody(cve, {
        cvssMetricV31: [{ type: 'Primary', cvssData: { vectorString: CRITICAL_VECTOR } }],
      });
    });
    const ctx = net(fetch);
    const cves = Array.from({ length: 7 }, (_, i) => `CVE-2024-${i}`);
    const client = new NvdClient(ctx, { clock, maxWaitMs: 1000 });
    const first = await client.lookup([...cves, 'GHSA-not-a-cve', 'CVE-2024-0']);
    expect(first.entries.size).toBe(5); // 5 per 30 s without a key
    expect(first.skipped).toEqual(['CVE-2024-5', 'CVE-2024-6']);
    expect(first.entries.get('CVE-2024-0')).toEqual({
      cvss: expect.objectContaining({ score: 9.8, source: 'nvd' }),
      description: 'CVE-2024-0 description',
    });

    const keyed = new NvdClient(ctx, { clock, apiKey: 'k', maxWaitMs: 0 });
    const second = await keyed.lookup(cves);
    expect(second.entries.size).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(7);
    expect((fetch.mock.calls[6]![1]!.headers as Record<string, string>).apiKey).toBe('k');
  });

  it('stops on 403 rate limiting, records empty results and rethrows other errors', async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(json({ vulnerabilities: [] }))
      .mockResolvedValueOnce(json({ message: 'forbidden' }, 403));
    const result = await new NvdClient(net(fetch), { clock: fakeClock() }).lookup([
      'CVE-1',
      'CVE-2',
      'CVE-3',
    ]);
    expect(result.entries.get('CVE-1')).toEqual({});
    expect(result.skipped).toEqual(['CVE-2', 'CVE-3']);

    const failing = new NvdClient(
      net(async () => json({}, 400)),
      { clock: fakeClock() },
    );
    await expect(failing.lookup(['CVE-1'])).rejects.toThrow(/HTTP 400/);
  });
});

describe('scan with GHSA and NVD', () => {
  it('adds GHSA-only advisories, merges duplicates and prefers NVD scores', async () => {
    const osv = fakeOsv({
      affected: { 'npm:lodash@4.17.15': ['GHSA-osv1'] },
      records: [
        ghsa('GHSA-osv1', 'lodash', { fixed: '4.17.19' }, { cve: 'CVE-osv1', vector: LOW_VECTOR }),
      ],
    });
    const fetch: FetchFn = async (url, init) => {
      if (url.includes('api.github.com')) {
        return json({
          data: {
            p0: {
              nodes: [
                ghsaNode('GHSA-osv1', 'lodash', '< 4.17.19', '4.17.19'), // duplicate of the OSV record
                ghsaNode('GHSA-only', 'lodash', '< 4.17.21', '4.17.21'), // only in GHSA
                ghsaNode('GHSA-old', 'lodash', '< 3.0.0', '3.0.0'), // does not affect 4.17.15
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (url.includes('nvd.nist.gov')) {
        const cve = new URL(url).searchParams.get('cveId')!;
        if (cve === 'CVE-osv1')
          return json({
            vulnerabilities: [
              {
                cve: {
                  id: cve,
                  metrics: {
                    cvssMetricV31: [
                      { type: 'Primary', cvssData: { vectorString: CRITICAL_VECTOR } },
                    ],
                  },
                },
              },
            ],
          });
        return json({ vulnerabilities: [] });
      }
      return osv.fetch(url, init);
    };
    const phases: string[] = [];
    const result = await scanManual('lodash@4.17.15', {
      fetch,
      ghsa: { token: 't' },
      nvd: { clock: fakeClock() },
      onProgress: (p) => phases.push(p),
    });
    expect(phases).toContain('enrich');
    expect(
      result.findings.map((f) => [
        f.vulnerability.id,
        f.vulnerability.cvss?.source,
        f.vulnerability.severity,
      ]),
    ).toEqual([
      // equal scores: ties break on the id
      ['CVE-only', 'ghsa', 'critical'],
      ['CVE-osv1', 'nvd', 'critical'],
    ]);
    expect(result.findings[0]!.remediation).toEqual({
      type: 'safe-patch',
      fixedVersion: '4.17.21',
    });
    expect(result.findings[1]!.vulnerability.aliases).toEqual(['CVE-osv1', 'GHSA-osv1']);
  });

  it('degrades to warnings when GHSA or NVD fail', async () => {
    const osv = fakeOsv({
      affected: { 'npm:a@1.0.0': ['GHSA-x'] },
      records: [ghsa('GHSA-x', 'a', { fixed: '1.0.1' }, { cve: 'CVE-x' })],
    });
    const fetch: FetchFn = async (url, init) => {
      if (url.includes('api.github.com')) return json({ message: 'Bad credentials' }, 401);
      if (url.includes('nvd.nist.gov')) return json({}, 500);
      return osv.fetch(url, init);
    };
    const result = await scanManual('a@1.0.0, go:stdlib@1.20.0', {
      fetch,
      ghsa: { token: 'bad' },
      nvd: { clock: fakeClock() },
      kev: false,
      epss: false,
    });
    expect(result.findings).toHaveLength(1);
    expect(result.warnings.map((w) => w.code).sort()).toEqual(['ghsa-failed', 'nvd-failed']);
  });

  it('reports partial NVD enrichment', async () => {
    const records = Array.from({ length: 6 }, (_, i) =>
      ghsa(`GHSA-${i}`, 'a', { fixed: '9.0.0' }, { cve: `CVE-${i}` }),
    );
    const osv = fakeOsv({ affected: { 'npm:a@1.0.0': records.map((r) => r.id) }, records });
    const fetch: FetchFn = async (url, init) =>
      url.includes('nvd') ? json({ vulnerabilities: [] }) : osv.fetch(url, init);
    const result = await scanManual('a@1.0.0', {
      fetch,
      nvd: { clock: fakeClock(), maxWaitMs: 0 },
    });
    expect(result.warnings.find((w) => w.code === 'nvd-partial')!.message).toContain(
      'fetched for 5 of 6 CVEs',
    );
  });
});
