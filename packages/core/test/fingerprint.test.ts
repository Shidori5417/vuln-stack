import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/cache/memory.js';
import { fingerprintSite } from '../src/fingerprint/detect.js';
import {
  RETIRE_REPOSITORY_URL,
  loadRetireSignatures,
  parseRetireRepository,
} from '../src/fingerprint/retire.js';
import { scanWebsite } from '../src/fingerprint/scan-website.js';
import {
  BUILTIN_SIGNATURES,
  RETIRE_CONTENT_LIMIT,
  cleanVersion,
  compileExtractor,
  matchContent,
  matchUrl,
  type Signature,
} from '../src/fingerprint/signatures.js';
import type { FetchFn } from '../src/net/context.js';
import { fakeOsv, ghsa, json } from './helpers.js';

const resolve = async () => ['93.184.216.34'];

interface Site {
  html: string;
  headers?: Record<string, string>;
  status?: number;
  assets?: Record<string, string | number>;
  fallback?: FetchFn;
}

function fakeSite(site: Site) {
  const calls: string[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push(url);
    if (url === 'https://example.com/') {
      return new Response(site.html, {
        status: site.status ?? 200,
        headers: { 'content-type': 'text/html', ...site.headers },
      });
    }
    const asset = site.assets?.[url];
    if (typeof asset === 'string') return new Response(asset);
    if (typeof asset === 'number') return new Response('x', { status: asset });
    if (site.fallback) return site.fallback(url, init);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return { fetch, calls };
}

const PAGE = `<!doctype html><html><head>
<meta name="generator" content="WordPress 5.8.1">
<link rel="stylesheet" href="/css/site.css">
<link rel="icon" href="/favicon.ico">
<script src="https://cdn.jsdelivr.net/npm/lodash@4.17.15/lodash.min.js"></script>
<script src='https://cdnjs.cloudflare.com/ajax/libs/jquery/3.4.1/jquery.min.js'></script>
<script src="https://code.jquery.com/ui/1.12.1/jquery-ui.min.js"></script>
<script src="/static/vendor.js?x=1&amp;y=2"></script>
<script src="//static.example.com/js/moment.js"></script>
<script src="https://evil.example.net/tracker.js"></script>
<script src="https://www.google-analytics.com/analytics.js"></script>
<script>inline()</script>
</head><body></body></html>`;

const PAGE_ASSETS = {
  'https://example.com/static/vendor.js?x=1&y=2':
    '/*! Bootstrap v4.3.1 (https://getbootstrap.com/) */ var a=1;',
  'https://static.example.com/js/moment.js':
    '//! moment.js\n//! version : 2.24.0\n//! license : MIT',
  'https://example.com/css/site.css': 'body{}',
};

describe('signatures', () => {
  it('extracts versions from URLs without eating file suffixes', () => {
    const hit = (url: string) =>
      matchUrl(BUILTIN_SIGNATURES, url).map((m) => `${m.npm}@${m.version}`);
    expect(hit('https://x.test/js/jquery-3.4.1.min.js')).toEqual(['jquery@3.4.1']);
    expect(hit('https://x.test/js/jquery-3.4.1.slim.min.js')).toEqual(['jquery@3.4.1']);
    expect(hit('https://x.test/jquery-migrate-3.0.0.js')).toEqual(['jquery-migrate@3.0.0']);
    expect(hit('https://x.test/bootstrap/4.3.1/js/bootstrap.bundle.min.js')).toEqual([
      'bootstrap@4.3.1',
    ]);
    expect(hit('https://x.test/jquery.min.js')).toEqual([]);
  });

  it('tells react and react-dom banners apart', () => {
    const react = '/** @license React v16.13.1\n * react.production.min.js\n */';
    const dom = '/** @license React v16.13.1\n * react-dom.production.min.js\n */';
    expect(matchContent(BUILTIN_SIGNATURES, react).map((m) => m.npm)).toEqual(['react']);
    expect(matchContent(BUILTIN_SIGNATURES, dom).map((m) => m.npm)).toEqual(['react-dom']);
  });

  it('reads banners of several libraries', () => {
    const banners: [string, string, string][] = [
      ['/*! jQuery v3.4.1 | (c) JS Foundation */', 'jquery', '3.4.1'],
      ['jQuery JavaScript Library v1.12.4', 'jquery', '1.12.4'],
      ['/** @license lodash 4.17.15 <https://lodash.com/> */', 'lodash', '4.17.15'],
      ['//     Underscore.js 1.9.1', 'underscore', '1.9.1'],
      ['/*! AngularJS v1.8.2 */', 'angular', '1.8.2'],
      ['/* Vue.js v2.6.14 */', 'vue', '2.6.14'],
      ['/*! @license DOMPurify 2.3.1 | (c) Cure53 */', 'dompurify', '2.3.1'],
      ['/* axios v0.21.1 | (c) 2020 */', 'axios', '0.21.1'],
      ['https://d3js.org v5.16.0 Copyright', 'd3', '5.16.0'],
      ['/*! Select2 4.0.13 | https://github.com/select2 */', 'select2', '4.0.13'],
      ['/*! jQuery UI - v1.12.1 - 2016-09-14 */', 'jquery-ui', '1.12.1'],
    ];
    for (const [text, npm, version] of banners) {
      expect(matchContent(BUILTIN_SIGNATURES, text), text).toContainEqual(
        expect.objectContaining({ npm, version }),
      );
    }
  });

  it('cleans and validates versions, and tolerates bad regexes', () => {
    expect(cleanVersion('3.4.1.')).toBe('3.4.1');
    expect(cleanVersion('1.0.0-beta.1')).toBe('1.0.0-beta.1');
    expect(cleanVersion('x')).toBeUndefined();
    expect(compileExtractor('(unclosed', '')).toBeUndefined();
    expect(compileExtractor('(unclosed', '')).toBeUndefined(); // cached failure
  });
});

describe('fingerprintSite', () => {
  const run = (site: Site, options: Partial<Parameters<typeof fingerprintSite>[1]> = {}) => {
    const fake = fakeSite(site);
    const promise = fingerprintSite('https://example.com/', {
      fetch: fake.fetch,
      resolve,
      ...options,
    });
    return { ...fake, promise };
  };

  it('detects technologies from headers, meta, CDN URLs, banners and keeps confidences', async () => {
    const { promise, calls } = run({
      html: PAGE,
      headers: {
        server: 'nginx/1.18.0 (Ubuntu)',
        'x-powered-by': 'Express, PHP/7.4.3',
        'x-aspnet-version': '4.0.30319',
        'x-drupal-cache': 'HIT',
      },
      assets: PAGE_ASSETS,
    });
    const result = await promise;

    const find = (name: string, version?: string) =>
      result.technologies.find((t) => t.name === name && t.version === version);
    expect(find('nginx', '1.18.0')).toMatchObject({ source: 'headers', confidence: 'medium' });
    expect(find('PHP', '7.4.3')).toBeDefined();
    expect(find('Express', undefined)).toMatchObject({ npm: 'express' });
    expect(find('ASP.NET', '4.0.30319')).toBeDefined();
    expect(find('Drupal', undefined)).toBeDefined();
    expect(find('WordPress', '5.8.1')).toMatchObject({ source: 'meta', confidence: 'medium' });
    expect(find('Lodash', '4.17.15')?.source).toContain('cdn.jsdelivr.net');
    expect(find('jQuery', '3.4.1')?.source).toContain('cdnjs.cloudflare.com');
    expect(find('jQuery UI', '1.12.1')).toBeDefined();
    expect(find('Bootstrap', '4.3.1')?.source).toBe('https://example.com/static/vendor.js?x=1&y=2');
    expect(find('Moment.js', '2.24.0')?.source).toBe('https://static.example.com/js/moment.js');

    expect(result.dependencies.map((d) => `${d.name}@${d.version}:${d.confidence}`).sort()).toEqual(
      [
        'bootstrap@4.3.1:medium',
        'jquery-ui@1.12.1:medium',
        'jquery@3.4.1:medium',
        'lodash@4.17.15:medium',
        'moment@2.24.0:medium',
      ],
    );
    for (const d of result.dependencies) {
      expect(d).toMatchObject({ ecosystem: 'npm', isDirect: true });
    }
    // Express has no version, so it is informational only.
    expect(result.dependencies.some((d) => d.name === 'express')).toBe(false);

    // One page + the two unresolved same-site assets (vendor.js, moment.js) + site.css.
    expect(calls[0]).toBe('https://example.com/');
    expect(
      calls.filter((c) => c.includes('evil.example.net') || c.includes('google-analytics')),
    ).toEqual([]);
    expect(calls).toHaveLength(4);
    expect(result.finalUrl).toBe('https://example.com/');
  });

  it('maps versioned framework headers to npm dependencies', async () => {
    const { promise } = run({
      html: '<html></html>',
      headers: { 'x-powered-by': 'Next.js/13.4.0', server: 'Apache/2.4.41 (Ubuntu) OpenSSL/1.1.1' },
    });
    const result = await promise;
    expect(result.dependencies).toEqual([
      expect.objectContaining({ name: 'next', version: '13.4.0', sourceFile: 'headers' }),
    ]);
    expect(result.technologies.map((t) => t.name)).toContain('Apache HTTP Server');
  });

  it('limits the number of inspected assets', async () => {
    const scripts = Array.from({ length: 6 }, (_, i) => `<script src="/a${i}.js"></script>`).join(
      '',
    );
    const assets = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`https://example.com/a${i}.js`, 'var a;']),
    );
    const { promise, calls } = run({ html: scripts, assets }, { maxAssets: 2 });
    const result = await promise;
    expect(calls).toHaveLength(3);
    expect(result.warnings.map((w) => w.code)).toContain('asset-limit');
  });

  it('ignores cross-site non-CDN scripts entirely', async () => {
    const { promise, calls } = run({
      html: '<script src="https://evil.example.net/jquery-1.2.3.min.js"></script><script src="javascript:alert(1)"></script><script src="http://[bad"></script>',
    });
    const result = await promise;
    expect(calls).toEqual(['https://example.com/']);
    expect(result.dependencies).toEqual([]);
  });

  it('reports failing assets and exhausted time budgets as warnings', async () => {
    const html = '<script src="/missing.js"></script>';
    const failed = await run({ html, assets: { 'https://example.com/missing.js': 404 } }).promise;
    expect(failed.warnings).toEqual([
      expect.objectContaining({
        code: 'asset-failed',
        message: expect.stringContaining('HTTP 404'),
      }),
    ]);

    const slow = run({ html: html + '<script src="/b.js"></script>' }, { timeBudgetMs: 0 });
    const result = await slow.promise;
    expect(slow.calls).toEqual(['https://example.com/']);
    expect(result.warnings.filter((w) => w.code === 'time-budget')).toHaveLength(1);
  });

  it('warns on error pages but still reads their headers', async () => {
    const result = await run({
      html: 'nope',
      status: 503,
      headers: { server: 'nginx/1.2.3' },
    }).promise;
    expect(result.warnings[0]).toMatchObject({ code: 'page-status' });
    expect(result.technologies[0]).toMatchObject({ name: 'nginx' });
  });

  it('uses low confidence for ?ver= and path heuristics', async () => {
    const result = await run({
      html: `<script src="/js/jquery.min.js?ver=3.5.1"></script>
<script src="/wp-includes/js/wp-embed.min.js?ver=5.8.1"></script>
<script src="/wp-content/themes/x/app.js?ver=zzz"></script>
<script src="/_next/static/chunks/main.js"></script>
<script src="/_nuxt/entry.js"></script>`,
      assets: {
        'https://example.com/js/jquery.min.js?ver=3.5.1': 'no banner',
        'https://example.com/wp-includes/js/wp-embed.min.js?ver=5.8.1': 'x',
        'https://example.com/wp-content/themes/x/app.js?ver=zzz': 'x',
        'https://example.com/_next/static/chunks/main.js': 'x',
        'https://example.com/_nuxt/entry.js': 'x',
      },
    }).promise;
    expect(result.dependencies).toEqual([
      expect.objectContaining({ name: 'jquery', version: '3.5.1', confidence: 'low' }),
    ]);
    const names = result.technologies.map((t) => `${t.name}@${t.version ?? ''}:${t.confidence}`);
    expect(names).toContain('WordPress@5.8.1:low');
    expect(names).not.toContain('WordPress@:low'); // redundant once versioned
    expect(names).toContain('Next.js@:low');
    expect(names).toContain('Nuxt@:low');
  });

  it('dedupes observations of the same name@version, keeping the best confidence', async () => {
    const result = await run({
      html: `<script src="/js/jquery.min.js?ver=3.4.1"></script><script src="https://code.jquery.com/jquery-3.4.1.min.js"></script>`,
      assets: { 'https://example.com/js/jquery.min.js?ver=3.4.1': 'x' },
    }).promise;
    expect(result.dependencies).toEqual([
      expect.objectContaining({ name: 'jquery', version: '3.4.1', confidence: 'medium' }),
    ]);
  });

  it('refuses private targets and redirects to them', async () => {
    await expect(
      fingerprintSite('http://169.254.169.254/', { fetch: async () => new Response(''), resolve }),
    ).rejects.toThrow(/not a public/);
  });

  describe('retire signatures', () => {
    const retire: Signature = {
      component: 'acme-lib',
      npm: 'acme-lib',
      origin: 'retire',
      uri: ['/acme-(§§version§§)\\.js'],
      filecontent: ['AcmeLib v(§§version§§) '],
    };

    it('applies inline signatures to URLs and content', async () => {
      const result = await run(
        {
          html: '<script src="/acme-1.2.3.js"></script><script src="/other.js"></script>',
          assets: { 'https://example.com/other.js': '/* AcmeLib v2.0.1 */' },
        },
        { signatures: [retire] },
      ).promise;
      expect(result.dependencies.map((d) => `${d.name}@${d.version}`).sort()).toEqual([
        'acme-lib@1.2.3',
        'acme-lib@2.0.1',
      ]);
    });

    it('does not run retire content regexes on oversized files', async () => {
      const big = 'AcmeLib v9.9.9 ' + 'x'.repeat(RETIRE_CONTENT_LIMIT);
      const small = { ...retire, origin: 'builtin' } as Signature;
      const html = '<script src="/big.js"></script>';
      const assets = { 'https://example.com/big.js': big };
      expect((await run({ html, assets }, { signatures: [retire] }).promise).dependencies).toEqual(
        [],
      );
      expect(
        (await run({ html, assets }, { signatures: [small] }).promise).dependencies,
      ).toHaveLength(1);
    });

    it('parses the retire repository format and drops unusable entries', () => {
      const sigs = parseRetireRepository({
        jquery: {
          npmname: 'jquery',
          extractors: {
            uri: ['/(§§version§§)/jquery\\.js', '(broken'],
            filename: ['jquery-(§§version§§)\\.js'],
            filecontent: ['jQuery v(§§version§§)'],
            hashes: {},
          },
        },
        nonpm: { extractors: { uri: ['x'] } },
        empty: { npmname: 'empty', extractors: { uri: ['(broken'] } },
        noext: { npmname: 'noext' },
      });
      expect(sigs).toEqual([
        {
          component: 'jquery',
          npm: 'jquery',
          origin: 'retire',
          uri: ['/(§§version§§)/jquery\\.js'],
          filename: ['jquery-(§§version§§)\\.js'],
          filecontent: ['jQuery v(§§version§§)'],
        },
      ]);
      expect(parseRetireRepository(null)).toEqual([]);
      expect(matchUrl(sigs, 'https://x.test/jquery-3.3.1.js')).toEqual([
        expect.objectContaining({ version: '3.3.1', via: 'filename' }),
      ]);
    });

    it('loads and caches signatures for 24 hours', async () => {
      const urls: string[] = [];
      const fetch: FetchFn = async (url) => {
        urls.push(url);
        return json({ x: { npmname: 'x', extractors: { uri: ['/x-(§§version§§)\\.js'] } } });
      };
      const cache = new MemoryCache();
      const first = await loadRetireSignatures(fetch, cache);
      const second = await loadRetireSignatures(fetch, cache);
      expect(second).toEqual(first);
      expect(urls).toEqual([RETIRE_REPOSITORY_URL]);
      await loadRetireSignatures(fetch);
      expect(urls).toHaveLength(2);
    });
  });
});

describe('scanWebsite', () => {
  const osv = () =>
    fakeOsv({
      affected: { 'npm:lodash@4.17.15': ['GHSA-aaaa-bbbb-cccc'] },
      records: [ghsa('GHSA-aaaa-bbbb-cccc', 'lodash', { fixed: '4.17.21' })],
    });

  it('scans detected libraries end to end', async () => {
    const o = osv();
    const site = fakeSite({
      html: PAGE,
      headers: { server: 'nginx/1.18.0' },
      assets: PAGE_ASSETS,
      fallback: o.fetch,
    });
    const result = await scanWebsite('https://example.com/', { fetch: site.fetch, resolve });

    expect(result.subprojects).toHaveLength(1);
    expect(result.subprojects[0]).toMatchObject({ path: 'example.com', ecosystem: 'npm' });
    expect(result.findings.map((f) => f.dependency.name)).toEqual(['lodash']);
    expect(result.findings[0]!.chain).toEqual(['example.com', 'lodash']);
    expect(result.detected).toContainEqual({
      name: 'nginx',
      version: '1.18.0',
      source: 'headers',
      confidence: 'medium',
    });
    expect(result.detected!.every((d) => !('npm' in d))).toBe(true);
  });

  it('reports pages without detectable libraries', async () => {
    const site = fakeSite({ html: '<html></html>', headers: { server: 'nginx/1.0.0' } });
    const result = await scanWebsite('https://example.com/', { fetch: site.fetch, resolve });
    expect(result.subprojects).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain('no-libraries');
    expect(result.detected).toHaveLength(1);
  });

  it('uses retire signatures when asked and survives their failure', async () => {
    const calls: string[] = [];
    const ok = fakeSite({
      html: '<script src="/zed-1.0.0.js"></script>',
      fallback: async (url, init) => {
        calls.push(url);
        if (url === RETIRE_REPOSITORY_URL) {
          return json({
            zed: { npmname: 'zed', extractors: { uri: ['/zed-(§§version§§)\\.js'] } },
          });
        }
        return osv().fetch(url, init);
      },
    });
    const withRetire = await scanWebsite('https://example.com/', {
      fetch: ok.fetch,
      resolve,
      retire: true,
      maxAssets: 5,
      userAgent: 'test-agent',
      signal: new AbortController().signal,
    });
    // fingerprint used its own fetch for the page; retire went through the injected one
    expect(calls).toContain(RETIRE_REPOSITORY_URL);
    expect(withRetire.subprojects[0]!.graph.nodes.has('zed@1.0.0')).toBe(true);

    const broken = fakeSite({
      html: '<html></html>',
      fallback: async () => new Response('no', { status: 404 }),
    });
    const failed = await scanWebsite('https://example.com/', {
      fetch: broken.fetch,
      resolve,
      retire: true,
    });
    expect(failed.warnings.map((w) => w.code)).toContain('retire-failed');
  });
});
