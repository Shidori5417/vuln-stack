import { describe, expect, it, vi } from 'vitest';
import { MemoryCache, type FetchFn } from '@vulnstack/core';
import { SsrfError } from '@vulnstack/core';
import { readConfig } from '@/server/config';
import { createPinnedLookup } from '@/server/pinned-fetch';
import { runScan } from '@/server/scan';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const config = readConfig({});

const lock = JSON.stringify({
  name: 'x',
  lockfileVersion: 3,
  packages: {
    '': { name: 'x', dependencies: { minimist: '1.2.0' } },
    'node_modules/minimist': { version: '1.2.0' },
  },
});

/** GitHub REST + OSV fake; records the authorization header of GitHub calls. */
function fakeGitHub(opts: { missing?: boolean } = {}) {
  const auth: (string | null)[] = [];
  const fetch: FetchFn = async (url, init) => {
    if (url.startsWith('https://api.github.com/')) {
      auth.push(new Headers(init?.headers).get('authorization'));
      if (opts.missing) return json({ message: 'Not Found' }, 404);
      if (url.endsWith('/repos/acme/app')) return json({ default_branch: 'main' });
      if (url.includes('/git/trees/main'))
        return json({ tree: [{ path: 'package-lock.json', type: 'blob', sha: 'abc', size: 100 }] });
      if (url.endsWith('/git/blobs/abc'))
        return json({
          encoding: 'base64',
          content: Buffer.from(lock).toString('base64'),
          size: lock.length,
        });
      return json({}, 404);
    }
    if (url.endsWith('/querybatch')) {
      const { queries } = JSON.parse(String(init!.body)) as { queries: unknown[] };
      return json({ results: queries.map(() => ({ vulns: [{ id: 'GHSA-mini' }] })) });
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
  return { fetch, auth };
}

describe('runScan: repo', () => {
  it('scans a public repo anonymously', async () => {
    const gh = fakeGitHub();
    const report = await runScan({ type: 'repo', url: 'acme/app' }, config, {
      fetch: gh.fetch,
      cache: new MemoryCache(),
    });
    expect(report.findings.map((f) => f.vulnerability.id)).toEqual(['CVE-2021-44906']);
    expect(gh.auth.every((a) => a === null)).toBe(true);
  });

  it('uses the signed-in token for GitHub and never returns it', async () => {
    const gh = fakeGitHub();
    const report = await runScan({ type: 'repo', url: 'https://github.com/acme/app' }, config, {
      fetch: gh.fetch,
      cache: new MemoryCache(),
      githubToken: 'user-secret-token',
    });
    expect(gh.auth.length).toBeGreaterThan(0);
    expect(gh.auth.every((a) => a === 'Bearer user-secret-token')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('user-secret-token');
  });

  it('maps a missing/private repo and bad input to client errors', async () => {
    const missing = fakeGitHub({ missing: true });
    await expect(
      runScan({ type: 'repo', url: 'acme/secret' }, config, {
        fetch: missing.fetch,
        cache: new MemoryCache(),
      }),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/not found or private/),
    });
    await expect(runScan({ type: 'repo', url: 'not a repo' }, config)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('runScan: url', () => {
  it('requires explicit consent', async () => {
    await expect(runScan({ type: 'url', url: 'https://example.com' }, config)).rejects.toThrow(
      /permission/,
    );
    await expect(
      runScan({ type: 'url', url: 'https://example.com', consent: false }, config),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    'http://127.0.0.1',
    'http://169.254.169.254/latest',
    'http://[::1]',
    'http://2130706433',
  ])('rejects blocked target %s with 400', async (url) => {
    const fetch = vi.fn<FetchFn>();
    await expect(
      runScan({ type: 'url', url, consent: true }, config, { fetch, cache: new MemoryCache() }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/can't be scanned/) });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('createPinnedLookup', () => {
  const lookup = (addresses: { address: string; family: number }[]) =>
    createPinnedLookup(async () => addresses);
  const call = (fn: ReturnType<typeof lookup>, all: boolean) =>
    new Promise<{ error: Error | null; address: unknown }>((resolve) =>
      fn('example.com', { all }, (error, address) => resolve({ error, address })),
    );

  it('rejects hosts resolving to private addresses', async () => {
    const r = await call(lookup([{ address: '10.0.0.5', family: 4 }]), true);
    expect(r.error).toBeInstanceOf(SsrfError);
    const mixed = await call(
      lookup([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
      false,
    );
    expect(mixed.error).toBeInstanceOf(SsrfError);
  });

  it('accepts public addresses in both lookup shapes', async () => {
    const fn = lookup([{ address: '93.184.216.34', family: 4 }]);
    expect(await call(fn, true)).toEqual({
      error: null,
      address: [{ address: '93.184.216.34', family: 4 }],
    });
    expect(await call(fn, false)).toEqual({ error: null, address: '93.184.216.34' });
  });

  it('propagates resolver failures', async () => {
    const fn = createPinnedLookup(async () => {
      throw new Error('ENOTFOUND');
    });
    expect((await call(fn, false)).error?.message).toBe('ENOTFOUND');
  });
});
