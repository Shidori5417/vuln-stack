import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryCache, type FetchFn } from '@vulnstack/core';
import { readConfig } from '@/server/config';
import { clientKey, RateLimiter } from '@/server/rate-limit';
import { runScan, sanitizePath, ScanInputError } from '@/server/scan';
import { suggest } from '@/server/suggest';

const fixture = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${p}`, import.meta.url)), 'utf8');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** OSV fake: minimist 1.2.0 has one advisory. */
const osvFetch: FetchFn = async (url, init) => {
  if (url.endsWith('/querybatch')) {
    const { queries } = JSON.parse(String(init!.body)) as {
      queries: { package: { name: string }; version: string }[];
    };
    return json({
      results: queries.map((q) =>
        q.package.name === 'minimist' && q.version === '1.2.0'
          ? { vulns: [{ id: 'GHSA-mini' }] }
          : {},
      ),
    });
  }
  return json({
    id: 'GHSA-mini',
    aliases: ['CVE-2021-44906'],
    summary: 'Prototype Pollution in minimist',
    affected: [
      {
        package: { ecosystem: 'npm', name: 'minimist' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.6' }] }],
      },
    ],
    database_specific: { severity: 'CRITICAL' },
  });
};

const config = { ...readConfig({}), maxFiles: 3 };

describe('readConfig', () => {
  it('reads limits and secrets from the environment', () => {
    expect(readConfig({})).toEqual({
      maxUploadBytes: 10 * 1024 * 1024,
      maxFiles: 200,
      scansPerMinute: 10,
      trustProxy: false,
      scanTimeoutMs: 55_000,
    });
    const c = readConfig({
      VULNSTACK_MAX_UPLOAD_MB: '2',
      VULNSTACK_TRUST_PROXY: '1',
      GITHUB_TOKEN: 't',
      NVD_API_KEY: 'k',
      VULNSTACK_SCANS_PER_MINUTE: 'x',
    });
    expect(c).toMatchObject({
      maxUploadBytes: 2 * 1024 * 1024,
      trustProxy: true,
      githubToken: 't',
      nvdApiKey: 'k',
      scansPerMinute: 10,
    });
  });
});

describe('sanitizePath', () => {
  it('normalises paths and rejects traversal or unsupported files', () => {
    expect(sanitizePath('./app\\package-lock.json')).toBe('app/package-lock.json');
    expect(sanitizePath('/abs/go.mod')).toBe('abs/go.mod');
    expect(() => sanitizePath('../etc/package.json')).toThrow(ScanInputError);
    expect(() => sanitizePath('')).toThrow(/Invalid file path/);
    expect(() => sanitizePath('secrets/.env')).toThrow(/Unsupported file: .env/);
  });
});

describe('runScan', () => {
  it('scans uploaded files in memory', async () => {
    const report = await runScan(
      {
        type: 'files',
        files: [
          {
            path: 'app/package-lock.json',
            content: fixture('npm/lock-v3-express/package-lock.json'),
          },
          { path: 'app/package.json', content: fixture('npm/lock-v3-express/package.json') },
        ],
      },
      config,
      { fetch: osvFetch, cache: new MemoryCache() },
    );
    expect(report.summary.dependencies).toBe(52);
    expect(report.findings.map((f) => f.vulnerability.id)).toEqual(['CVE-2021-44906']);
    expect(report.subprojects[0]!.path).toBe('app');
  });

  it('scans a structured package list', async () => {
    const report = await runScan(
      {
        type: 'packages',
        packages: [
          { ecosystem: 'npm', name: 'minimist', version: '1.2.0' },
          { ecosystem: 'PyPI', name: 'django', version: '4.1' },
        ],
      },
      config,
      { fetch: osvFetch, cache: new MemoryCache() },
    );
    expect(report.summary.subprojects).toBe(2);
    expect(report.findings[0]!.chain).toEqual(['manual', 'minimist']);
  });

  it('rejects malformed bodies and too many files', async () => {
    await expect(runScan({ type: 'nope' }, config)).rejects.toThrow(/Invalid request/);
    await expect(
      runScan(
        { type: 'packages', packages: [{ ecosystem: 'Cargo', name: 'x', version: '1' }] },
        config,
      ),
    ).rejects.toThrow(/packages.0.ecosystem/);
    const many = Array.from({ length: 4 }, (_, i) => ({
      path: `p${i}/package.json`,
      content: '{}',
    }));
    await expect(runScan({ type: 'files', files: many }, config)).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe('rate limiting', () => {
  it('counts per key per window', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('b')]).toEqual([0, 0, 0]);
    expect(limiter.hit('a')).toBe(60);
    now = 30_000;
    expect(limiter.hit('a')).toBe(30);
    now = 60_000;
    expect(limiter.hit('a')).toBe(0);
  });

  it('only trusts forwarded headers behind a proxy', () => {
    const h = new Headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1', 'x-real-ip': '5.6.7.8' });
    expect(clientKey(h, true)).toBe('1.2.3.4');
    expect(clientKey(new Headers({ 'x-real-ip': '5.6.7.8' }), true)).toBe('5.6.7.8');
    expect(clientKey(h, false)).toBe('anonymous');
    expect(clientKey(new Headers(), true)).toBe('anonymous');
  });
});

describe('suggest', () => {
  it('queries registry search APIs and caches results', async () => {
    const calls: string[] = [];
    const fetch: FetchFn = async (url) => {
      calls.push(url);
      if (url.includes('npmjs'))
        return json({
          objects: [{ package: { name: 'react', version: '19.0.0', description: 'UI' } }],
        });
      if (url.includes('packagist')) return json({ results: [{ name: 'laravel/framework' }] });
      if (url.includes('nuget'))
        return json({ data: [{ id: 'Newtonsoft.Json', version: '13.0.3' }] });
      if (url.includes('maven'))
        return json({
          response: { docs: [{ g: 'org.slf4j', a: 'slf4j-api', latestVersion: '2.0.0' }] },
        });
      if (url.includes('pypi'))
        return url.includes('nope')
          ? json({}, 404)
          : json({ info: { name: 'Django', version: '5.0' } });
      throw new Error('offline');
    };
    expect(await suggest('npm', 'reac', fetch)).toEqual([
      { name: 'react', version: '19.0.0', description: 'UI' },
    ]);
    expect(await suggest('npm', 'reac', fetch)).toHaveLength(1);
    expect(calls.filter((c) => c.includes('npmjs'))).toHaveLength(1);
    expect(await suggest('Packagist', 'larav', fetch)).toEqual([{ name: 'laravel/framework' }]);
    expect(await suggest('NuGet', 'newton', fetch)).toEqual([
      { name: 'Newtonsoft.Json', version: '13.0.3' },
    ]);
    expect(await suggest('Maven', 'slf4j', fetch)).toEqual([
      { name: 'org.slf4j:slf4j-api', version: '2.0.0' },
    ]);
    expect(await suggest('PyPI', 'django', fetch)).toEqual([{ name: 'Django', version: '5.0' }]);
    expect(await suggest('PyPI', 'nope', fetch)).toEqual([]);
    expect(await suggest('Go', 'gin', fetch)).toEqual([]);
    expect(await suggest('npm', 'r', fetch)).toEqual([]);
    expect(
      await suggest('Packagist', 'boom', async () => {
        throw new Error('x');
      }),
    ).toEqual([]);
  });
});
