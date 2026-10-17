import { describe, expect, it } from 'vitest';
import { MemoryCache, type FetchFn } from '@vulnstack/core';
import { runCli } from '../src/program.js';
import type { CliIO } from '../src/io.js';
import { createPinnedLookup } from '../src/net.js';

const LOCK = JSON.stringify({
  name: 'demo',
  lockfileVersion: 3,
  packages: {
    '': { name: 'demo', version: '1.0.0', dependencies: { minimist: '1.2.0' } },
    'node_modules/minimist': { version: '1.2.0' },
  },
});

const TOKEN = 'ghp_SECRETTOKEN123';
const seenAuth: (string | undefined)[] = [];

function osv(url: string, init?: RequestInit): Response | undefined {
  const json = (b: unknown) => new Response(JSON.stringify(b));
  if (url.endsWith('/querybatch')) {
    const { queries } = JSON.parse(String(init!.body)) as { queries: unknown[] };
    return json({ results: queries.map(() => ({ vulns: [{ id: 'GHSA-mini' }] })) });
  }
  if (url.includes('/vulns/')) {
    return json({
      id: 'GHSA-mini',
      aliases: ['CVE-2021-44906'],
      summary: 'minimist is vulnerable',
      affected: [
        {
          package: { ecosystem: 'npm', name: 'minimist' },
          ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.6' }] }],
        },
      ],
    });
  }
  return undefined;
}

const githubFetch: FetchFn = async (url, init) => {
  const headers = init?.headers as Record<string, string> | undefined;
  if (url.includes('api.github.com')) {
    seenAuth.push(headers?.authorization);
    if (url.includes('/repos/acme/private')) return new Response('{}', { status: 404 });
    if (url.endsWith('/repos/acme/demo')) return new Response('{"default_branch":"main"}');
    if (url.includes('/git/trees/'))
      return new Response(
        JSON.stringify({
          tree: [{ path: 'package-lock.json', type: 'blob', sha: 'abc', size: 100 }],
        }),
      );
    if (url.includes('/git/blobs/abc'))
      return new Response(
        JSON.stringify({
          encoding: 'base64',
          size: LOCK.length,
          content: Buffer.from(LOCK).toString('base64'),
        }),
      );
  }
  return osv(url, init) ?? new Response('not found', { status: 404 });
};

const HTML = '<html><head><meta name="generator" content="WordPress 6.0"></head></html>';
const siteFetch: FetchFn = async (url, init) =>
  osv(url, init) ??
  new Response(HTML, { headers: { 'content-type': 'text/html', server: 'nginx/1.18.0' } });

function makeIO(overrides: Partial<CliIO> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    stdout: { write: (s: string) => out.push(s), columns: 160 },
    stderr: { write: (s: string) => err.push(s) },
    cwd: '/nonexistent',
    env: {},
    fetch: githubFetch,
    cache: new MemoryCache(),
    resolve: async () => ['93.184.216.34'],
    ...overrides,
  };
  return { io, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('scan --repo', () => {
  it('scans a GitHub repo and sends the token without printing it', async () => {
    seenAuth.length = 0;
    const t = makeIO({ env: { GITHUB_TOKEN: TOKEN, NO_COLOR: '1' } });
    expect(await runCli(['scan', '--repo', 'acme/demo', '--no-ghsa'], t.io)).toBe(0);
    expect(t.stdout()).toContain('CVE-2021-44906');
    expect(seenAuth.length).toBeGreaterThan(0);
    expect(seenAuth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    expect(t.stdout() + t.stderr()).not.toContain(TOKEN);
  });

  it('explains a missing or private repository', async () => {
    const t = makeIO();
    expect(await runCli(['scan', '--repo', 'https://github.com/acme/private'], t.io)).toBe(2);
    expect(t.stderr()).toMatch(/not found or private/);
  });

  it.each([
    [['scan', '.', '--repo', 'acme/demo']],
    [['scan', '--manual', 'a@1.0.0', '--repo', 'acme/demo']],
    [['scan', '--repo', 'acme/demo', '--url', 'https://example.com']],
  ])('rejects combined sources %j', async (argv) => {
    const t = makeIO();
    expect(await runCli(argv, t.io)).toBe(2);
    expect(t.stderr()).toContain('mutually exclusive');
  });
});

describe('scan --url', () => {
  const base = ['scan', '--url', 'https://example.com'];

  it('needs explicit consent', async () => {
    const t = makeIO({ fetch: siteFetch });
    expect(await runCli(base, t.io)).toBe(2);
    expect(t.stderr()).toContain('--i-own-this-site');
    expect(t.stderr()).toContain('passive');
  });

  it('renders detected technologies with consent flag or env', async () => {
    for (const [args, env] of [
      [[...base, '--i-own-this-site'], {}],
      [base, { VULNSTACK_URL_CONSENT: '1' }],
    ] as const) {
      const t = makeIO({ fetch: siteFetch, env });
      expect(await runCli([...args], t.io)).toBe(0);
      expect(t.stdout()).toContain('Detected technologies');
      expect(t.stdout()).toContain('WordPress');
      expect(t.stdout()).toContain('6.0');
    }
  });

  it.each(['http://127.0.0.1', 'http://169.254.169.254'])('refuses %s', async (url) => {
    const t = makeIO({ fetch: siteFetch });
    expect(await runCli(['scan', '--url', url, '--i-own-this-site'], t.io)).toBe(2);
    expect(t.stderr()).toMatch(/not a public address/);
  });
});

describe('createPinnedLookup', () => {
  const run = (host: string, addrs: string[], all = false) =>
    new Promise<{ err: Error | null; res: unknown }>((resolve) => {
      createPinnedLookup(async () => addrs.map((address) => ({ address, family: 4 })))(
        host,
        { all },
        (err, res) => resolve({ err, res }),
      );
    });

  it('accepts public addresses', async () => {
    expect((await run('a.test', ['93.184.216.34'])).res).toBe('93.184.216.34');
    expect((await run('a.test', ['93.184.216.34'], true)).res).toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('rejects when any address is private', async () => {
    for (const bad of ['10.0.0.1', '127.0.0.1', '169.254.169.254']) {
      const { err } = await run('evil.test', ['93.184.216.34', bad]);
      expect(err?.message).toContain('private or reserved');
    }
  });
});
