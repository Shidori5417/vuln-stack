import { describe, expect, it } from 'vitest';
import { GitHubFileProvider, parseGitHubUrl, scanGitHubRepo } from '../src/sources/github.js';
import type { FetchFn } from '../src/net/context.js';
import { fakeOsv, ghsa, json } from './helpers.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

interface FakeRepo {
  tree: { path: string; type?: string; size?: number }[];
  blobs: Record<string, string>;
  truncated?: boolean;
  fallback?: FetchFn;
}

function fakeGitHub(repo: FakeRepo) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const u = new URL(url);
    if (u.host !== 'api.github.com') {
      if (repo.fallback) return repo.fallback(url, init);
      throw new Error(`Unexpected fetch: ${url}`);
    }
    if (u.pathname === '/repos/o/r') return json({ default_branch: 'main' });
    if (u.pathname.startsWith('/repos/o/r/git/trees/')) {
      return json({
        tree: repo.tree.map((t) => ({ type: 'blob', sha: `sha-${t.path}`, ...t })),
        truncated: repo.truncated ?? false,
      });
    }
    const blob = /\/git\/blobs\/sha-(.+)$/.exec(u.pathname);
    if (blob) {
      const content = repo.blobs[blob[1]!];
      return content === undefined
        ? json({ message: 'Not Found' }, 404)
        : json({ encoding: 'base64', content: b64(content), size: Buffer.byteLength(content) });
    }
    return json({ message: 'Not Found' }, 404);
  };
  return { fetch, calls };
}

describe('parseGitHubUrl', () => {
  it.each([
    ['https://github.com/o/r', { owner: 'o', repo: 'r' }],
    ['https://github.com/o/r.git', { owner: 'o', repo: 'r' }],
    ['https://github.com/o/r/', { owner: 'o', repo: 'r' }],
    ['github.com/o/r', { owner: 'o', repo: 'r' }],
    ['o/r', { owner: 'o', repo: 'r' }],
    ['git@github.com:o/r.git', { owner: 'o', repo: 'r' }],
    ['https://github.com/o/r/tree/v1', { owner: 'o', repo: 'r', ref: 'v1' }],
    [
      'https://github.com/o/r/tree/main/apps/web',
      { owner: 'o', repo: 'r', ref: 'main', subdir: 'apps/web' },
    ],
  ])('parses %s', (input, expected) => {
    expect(parseGitHubUrl(input)).toEqual(expected);
  });

  it.each(['', 'nope', 'https://gitlab.com/o/r', 'https://github.com/o', 'a b/c'])(
    'rejects %j',
    (input) => {
      expect(() => parseGitHubUrl(input)).toThrow(/Not a GitHub repository/);
    },
  );
});

describe('GitHubFileProvider', () => {
  const make = (repo: FakeRepo, extra = {}) => {
    const gh = fakeGitHub(repo);
    return {
      gh,
      provider: new GitHubFileProvider({ owner: 'o', repo: 'r', fetch: gh.fetch, ...extra }),
    };
  };

  it('lists supported files, skips ignored dirs and honours subdir', async () => {
    const repo: FakeRepo = {
      tree: [
        { path: 'package.json' },
        { path: 'README.md' },
        { path: 'node_modules/x/package.json' },
        { path: 'apps/web/package-lock.json' },
        { path: 'apps/web/src/index.ts' },
        { path: 'apps/api/go.mod' },
        { path: 'apps', type: 'tree' },
      ],
      blobs: {},
    };
    const all = make(repo);
    expect(await all.provider.list()).toEqual([
      'apps/api/go.mod',
      'apps/web/package-lock.json',
      'package.json',
    ]);
    expect(all.provider.ref).toBe('main');

    const sub = make(repo, { subdir: '/apps/web/' });
    expect(await sub.provider.list()).toEqual(['package-lock.json']);
  });

  it('skips the default-branch lookup when a ref is given and sends headers', async () => {
    const { gh, provider } = make(
      { tree: [{ path: 'go.mod' }], blobs: {} },
      { ref: 'v1', token: 'tok-123' },
    );
    await provider.list();
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]!.url).toContain('/git/trees/v1?recursive=1');
    expect(gh.calls[0]!.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: 'Bearer tok-123',
    });
  });

  it('omits authorization without a token', async () => {
    const { gh, provider } = make({ tree: [], blobs: {} });
    await provider.list();
    expect(gh.calls.every((c) => !('authorization' in c.headers))).toBe(true);
  });

  it('warns about truncated trees and file caps', async () => {
    const { provider } = make(
      {
        tree: [{ path: 'a/go.mod' }, { path: 'b/go.mod' }, { path: 'c/go.mod' }],
        blobs: {},
        truncated: true,
      },
      { maxFiles: 2 },
    );
    expect(await provider.list()).toEqual(['a/go.mod', 'b/go.mod']);
    expect(provider.warnings.map((w) => w.code)).toEqual([
      'github-tree-truncated',
      'github-file-cap',
    ]);
  });

  it('decodes UTF-8 blobs and rejects unknown paths', async () => {
    const { provider } = make({
      tree: [{ path: 'package.json' }],
      blobs: { 'package.json': '{"name":"ünï-çødé 日本"}' },
    });
    expect(await provider.read('package.json')).toBe('{"name":"ünï-çødé 日本"}');
    await expect(provider.read('nope.json')).rejects.toThrow(/File not found/);
  });

  it('enforces size limits', async () => {
    const big = 'x'.repeat(50);
    const repo: FakeRepo = {
      tree: [{ path: 'package.json', size: 50 }, { path: 'go.mod' }, { path: 'composer.json' }],
      blobs: { 'package.json': big, 'go.mod': big, 'composer.json': big },
    };
    await expect(make(repo, { maxFileBytes: 10 }).provider.read('package.json')).rejects.toThrow(
      /larger than/,
    );
    // size unknown in the tree: caught from the blob response
    await expect(make(repo, { maxFileBytes: 10 }).provider.read('go.mod')).rejects.toThrow(
      /larger than/,
    );
    const total = make(repo, { maxTotalBytes: 80 }).provider;
    await total.read('go.mod');
    await expect(total.read('composer.json')).rejects.toThrow(/Total size limit/);
  });

  it('rejects unexpected blob encodings', async () => {
    const fetch: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return json({ tree: [{ path: 'go.mod', type: 'blob', sha: 's' }] });
      }
      return json({ encoding: 'utf-8', content: 'x', size: 1 });
    };
    const provider = new GitHubFileProvider({ owner: 'o', repo: 'r', ref: 'main', fetch });
    await expect(provider.read('go.mod')).rejects.toThrow(/Unexpected blob encoding/);
  });

  describe('errors', () => {
    const failing = (status: number, headers: Record<string, string> = {}) =>
      new GitHubFileProvider({
        owner: 'o',
        repo: 'r',
        token: 'secret-token-value',
        fetch: async () => json({ message: 'x' }, status, headers),
      });

    it('maps 404', async () => {
      await expect(failing(404).list()).rejects.toThrow(
        'Repository not found or private (sign in / provide a token)',
      );
    });
    it('maps 401', async () => {
      await expect(failing(401).list()).rejects.toThrow(/access token/);
    });
    it('maps rate limits with reset time and never leaks the token', async () => {
      const err = await failing(403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1800000000',
      })
        .list()
        .catch((e: Error) => e);
      expect((err as Error).message).toMatch(/rate limit exceeded; resets at 2027-01-15T08:00:00/);
      expect((err as Error).message).not.toContain('secret-token-value');
    });
    it('reports other 403 and server errors', async () => {
      await expect(failing(403).list()).rejects.toThrow(/denied access/);
      await expect(failing(500).list()).rejects.toThrow(/GitHub API error 500/);
    });
    it('hints at tokens for anonymous rate limits', async () => {
      const provider = new GitHubFileProvider({
        owner: 'o',
        repo: 'r',
        fetch: async () => json({}, 429, { 'x-ratelimit-remaining': '0' }),
      });
      await expect(provider.list()).rejects.toThrow(/provide a token/);
    });
  });
});

describe('scanGitHubRepo', () => {
  const lock = (deps: Record<string, string>) =>
    JSON.stringify({
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', dependencies: deps },
        ...Object.fromEntries(
          Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, { version: v }]),
        ),
      },
    });

  it('scans each manifest folder separately and appends provider warnings', async () => {
    const osv = fakeOsv({
      affected: { 'npm:lodash@4.17.15': ['GHSA-aaaa-bbbb-cccc'] },
      records: [ghsa('GHSA-aaaa-bbbb-cccc', 'lodash', { fixed: '4.17.21' })],
      registry: { lodash: { versions: ['4.17.15', '4.17.21'] } },
    });
    const gh = fakeGitHub({
      tree: [
        { path: 'web/package-lock.json' },
        { path: 'api/package-lock.json' },
        { path: 'node_modules/x/package-lock.json' },
      ],
      blobs: {
        'web/package-lock.json': lock({ lodash: '4.17.15' }),
        'api/package-lock.json': lock({ express: '4.19.2' }),
      },
      truncated: true,
      fallback: osv.fetch,
    });

    const result = await scanGitHubRepo('https://github.com/o/r', {
      fetch: gh.fetch,
      token: 'tok',
    });
    expect(result.subprojects.map((s) => s.path).sort()).toEqual(['api', 'web']);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.subproject).toBe('web');
    expect(result.warnings.some((w) => w.code === 'github-tree-truncated')).toBe(true);
  });
});
