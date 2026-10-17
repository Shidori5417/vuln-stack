import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { OsvRecord } from '../src/advisories/osv.js';
import { OfflineDatabase, buildOfflineIndex } from '../src/offline/index.js';
import { ZipError, readZip } from '../src/offline/zip.js';
import {
  LazyOfflineDatabase,
  loadOfflineDatabase,
  readOfflineMeta,
  updateOfflineDatabase,
} from '../src/node/offline.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { scanFiles } from '../src/scan.js';
import { FIXTURES, fakeOsv, ghsa, json } from './helpers.js';
import { makeZip } from './offline-zip-writer.js';

const names = (data: Uint8Array) => [...readZip(data, inflateRawSync)].map((e) => e.name);
const text = (data: Uint8Array) =>
  [...readZip(data, inflateRawSync)].map((e) => Buffer.from(e.read()).toString());

describe('zip reader', () => {
  const files = [
    { name: 'a.json', data: '{"a":1}'.repeat(50) },
    { name: 'dir/', data: '' },
    { name: 'b.json', data: 'stored!', stored: true },
  ];

  it('reads deflated and stored entries, skipping directories', () => {
    const zip = makeZip(files);
    expect(names(zip)).toEqual(['a.json', 'b.json']);
    expect(text(zip)).toEqual(['{"a":1}'.repeat(50), 'stored!']);
  });

  it('reads ZIP64 central directories', () => {
    const zip = makeZip(files, { zip64: true });
    expect(text(zip)).toEqual(['{"a":1}'.repeat(50), 'stored!']);
  });

  it('rejects corrupt input', () => {
    expect(() => names(new Uint8Array(10))).toThrow(ZipError);
    expect(() => names(new TextEncoder().encode('x'.repeat(100)))).toThrow(/end of central/);
    const zip = makeZip(files);
    const broken = zip.slice();
    broken[zip.length - 22 + 16] = 0xff; // central directory offset points into nowhere
    broken[zip.length - 22 + 17] = 0xff;
    expect(() => names(broken)).toThrow(ZipError);
    const noZ64 = makeZip(files);
    noZ64[noZ64.length - 22 + 10] = 0xff;
    noZ64[noZ64.length - 22 + 11] = 0xff;
    expect(() => names(noZ64)).toThrow(/ZIP64 locator/);
  });

  it('rejects bad local headers, unknown methods and size mismatches', () => {
    const zip = makeZip([{ name: 'a.json', data: 'hello world' }]);
    const badLocal = zip.slice();
    badLocal[0] = 0;
    expect(() => text(badLocal)).toThrow(/local header/);
    const method = zip.slice();
    const cen = method.findIndex(
      (_, i) =>
        method[i] === 0x50 && method[i + 1] === 0x4b && method[i + 2] === 1 && method[i + 3] === 2,
    );
    method[cen + 10] = 9;
    expect(() => text(method)).toThrow(/method 9/);
    const size = zip.slice();
    size[cen + 24] = 99;
    expect(() => text(size)).toThrow(/size mismatch/);
    const trunc = zip.slice();
    trunc[cen + 20] = 0xf0; // compressed size beyond the buffer
    expect(() => text(trunc)).toThrow(/truncated/);
  });
});

const range = (
  eco: string,
  name: string,
  events: Record<string, string>[],
  type: 'SEMVER' | 'ECOSYSTEM' = 'SEMVER',
) => ({
  package: { ecosystem: eco, name },
  ranges: [{ type, events }],
});

describe('offline index', () => {
  const records: OsvRecord[] = [
    { id: 'A', affected: [range('npm', 'lodash', [{ introduced: '0' }, { fixed: '4.17.21' }])] },
    {
      id: 'W',
      withdrawn: '2024-01-01T00:00:00Z',
      affected: [range('npm', 'lodash', [{ introduced: '0' }])],
    },
    {
      id: 'MIX',
      affected: [
        range('npm', 'x', [{ introduced: '1.0.0' }, { last_affected: '1.5.0' }]),
        range('PyPI', 'x', [{ introduced: '0' }]),
      ],
    },
    {
      id: 'PY',
      affected: [
        range(
          'PyPI',
          'Django_Rest.Framework',
          [{ introduced: '0' }, { fixed: '2.0' }],
          'ECOSYSTEM',
        ),
      ],
    },
    { id: 'NOPKG', affected: [{ ranges: [] }] },
    { id: 'DEB', affected: [range('Debian:11', 'lodash', [{ introduced: '0' }])] },
  ];

  it('keeps only matching ecosystems and drops withdrawn records', () => {
    const idx = buildOfflineIndex('npm', records, '2026-01-01T00:00:00.000Z');
    expect(Object.keys(idx.packages).sort()).toEqual(['lodash', 'x']);
    expect(idx.packages.lodash!.map((r) => r.id)).toEqual(['A']);
    expect(idx.packages.x![0]!.affected).toHaveLength(1);
    expect(idx.builtAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('queries versions and ranges', () => {
    const db = new OfflineDatabase([buildOfflineIndex('npm', records)]);
    expect(db.query('npm', 'lodash', '4.17.15').map((r) => r.id)).toEqual(['A']);
    expect(db.query('npm', 'lodash', '4.17.21')).toEqual([]);
    expect(db.query('npm', 'x', '1.5.0').map((r) => r.id)).toEqual(['MIX']);
    expect(db.query('npm', 'x', '1.5.1')).toEqual([]);
    expect(db.query('npm', 'nope', '1.0.0')).toEqual([]);
    expect(db.query('npm', '__proto__', '1.0.0')).toEqual([]);
    expect(db.query('Go', 'lodash', '1.0.0')).toEqual([]);
    expect(db.ecosystems).toEqual(['npm']);
  });

  it('normalises PyPI names', () => {
    const db = new OfflineDatabase([buildOfflineIndex('PyPI', records)]);
    expect(db.query('PyPI', 'django-rest-framework', '1.0').map((r) => r.id)).toEqual(['PY']);
    expect(db.query('PyPI', 'DJANGO.rest.framework', '2.0')).toEqual([]);
    expect(db.query('PyPI', 'x', '9').map((r) => r.id)).toEqual(['MIX']);
  });
});

const lodashRecord = ghsa(
  'GHSA-p6mc-m468-83gw',
  'lodash',
  { fixed: '4.17.19' },
  { cve: 'CVE-2020-8203' },
);

describe('updateOfflineDatabase / loadOfflineDatabase', () => {
  const zip = makeZip([
    { name: 'GHSA-p6mc-m468-83gw.json', data: JSON.stringify(lodashRecord) },
    { name: 'README.txt', data: 'ignored' },
  ]);
  const serve = (calls: { url: string; headers?: unknown }[], etag = '"e1"') =>
    (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers });
      const inm = (init?.headers as Record<string, string> | undefined)?.['If-None-Match'];
      if (inm === etag) return new Response(null, { status: 304 });
      if (url.includes('/Missing/')) return new Response('no', { status: 404 });
      return new Response(zip, { headers: { etag, 'last-modified': 'Mon' } });
    }) as never;

  it('downloads, indexes, writes and reloads; second run is a 304', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'vs-off-')), 'db');
    const calls: { url: string; headers?: unknown }[] = [];
    const progress: string[] = [];
    const res = await updateOfflineDatabase({
      ecosystems: ['npm', 'Go'],
      dir,
      fetch: serve(calls),
      baseUrl: 'https://dump.test',
      now: () => new Date('2026-02-01T00:00:00Z'),
      onProgress: (m) => progress.push(m),
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://dump.test/npm/all.zip',
      'https://dump.test/Go/all.zip',
    ]);
    expect(res.updated.npm).toMatchObject({
      records: 1,
      packages: 1,
      etag: '"e1"',
      lastModified: 'Mon',
    });
    expect(res.updated.Go).toMatchObject({ records: 0 });
    expect(progress).toContain('npm: 1 records');
    const meta = await readOfflineMeta(dir);
    expect(meta.npm!.builtAt).toBe('2026-02-01T00:00:00.000Z');
    JSON.parse(readFileSync(join(dir, 'npm.json'), 'utf8')); // still valid JSON

    const { database, missing } = await loadOfflineDatabase(dir, ['npm', 'PyPI']);
    expect(missing).toEqual(['PyPI']);
    expect(database.query('npm', 'lodash', '4.17.0')).toHaveLength(1);
    expect(database.builtAt).toEqual({ npm: '2026-02-01T00:00:00.000Z' });

    const lazy = new LazyOfflineDatabase(dir);
    expect(lazy.warnings()).toEqual([]); // nothing queried yet, nothing loaded
    expect(await lazy.query('npm', 'lodash', '4.17.0')).toHaveLength(1);
    expect(lazy.warnings()).toEqual([]);
    expect(await lazy.query('PyPI', 'django', '3.0')).toEqual([]);
    expect(await lazy.query('PyPI', 'flask', '1.0')).toEqual([]);
    expect(lazy.warnings().map((w) => w.code)).toEqual(['offline-missing-ecosystem']);

    const again = await updateOfflineDatabase({
      ecosystems: ['npm'],
      dir,
      fetch: serve([]),
      baseUrl: 'https://dump.test',
    });
    expect(again.unchanged).toEqual(['npm']);
    expect(again.updated).toEqual({});
  });

  it('enforces the size limit and reports HTTP errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-off-'));
    const base = { dir, baseUrl: 'https://dump.test', ecosystems: ['npm'] as const };
    await expect(
      updateOfflineDatabase({ ...base, fetch: serve([]), maxBytes: 10 }),
    ).rejects.toThrow(/size limit/);
    const big = (async () =>
      new Response(zip, { headers: { 'content-length': '999999' } })) as never;
    await expect(updateOfflineDatabase({ ...base, fetch: big, maxBytes: 10 })).rejects.toThrow(
      /over the size limit/,
    );
    const bad = (async () => new Response('x', { status: 500 })) as never;
    await expect(updateOfflineDatabase({ ...base, fetch: bad })).rejects.toThrow(/HTTP 500/);
    const noBody = (async () => new Response(null, { status: 200 })) as never;
    await expect(updateOfflineDatabase({ ...base, fetch: noBody })).rejects.toThrow(/no body/);
  });

  it('load rethrows non-ENOENT errors and rejects empty files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-off-'));
    writeFileSync(join(dir, 'npm.json'), '');
    await expect(loadOfflineDatabase(dir, ['npm'])).rejects.toThrow(/empty/);
    await expect(loadOfflineDatabase(join(dir, 'npm.json'), ['npm'])).rejects.toThrow();
    expect(await readOfflineMeta(join(dir, 'none'))).toEqual({});
  });
});

describe('scan with offline database', () => {
  const records = [
    ghsa('GHSA-qw6h-vgh9-j6wx', 'express', { fixed: '4.20.0' }, { cve: 'CVE-2024-43796' }),
    ghsa('GHSA-qwcr-r2fm-qrc7', 'body-parser', { fixed: '1.20.3' }, { cve: 'CVE-2024-45590' }),
    ghsa('GHSA-35jh-r3h4-6jhm', 'lodash', { fixed: '4.17.21' }, { cve: 'CVE-2021-23337' }),
    lodashRecord,
    ghsa('GHSA-xvch-5gv4-984h', 'minimist', { fixed: '1.2.6' }, { cve: 'CVE-2021-44906' }),
  ];

  it('matches the online result and makes no network calls', async () => {
    const provider = () => new FsFileProvider(join(FIXTURES, 'npm/lock-v3-express'));
    const online = fakeOsv({
      affected: {
        'npm:express@4.17.1': ['GHSA-qw6h-vgh9-j6wx'],
        'npm:body-parser@1.19.0': ['GHSA-qwcr-r2fm-qrc7'],
        'npm:lodash@4.17.15': ['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'],
        'npm:minimist@1.2.0': ['GHSA-xvch-5gv4-984h'],
      },
      records,
    });
    const expected = await scanFiles(provider(), { fetch: online.fetch });

    const db = new OfflineDatabase([buildOfflineIndex('npm', records, '2026-03-01T00:00:00Z')]);
    const fetch = async (): Promise<Response> => {
      throw new Error('network used');
    };
    const phases: string[] = [];
    const offline = await scanFiles(provider(), {
      fetch,
      offline: db,
      ghsa: { token: 't' },
      nvd: {},
      onProgress: (p) => phases.push(p),
    });
    expect(phases).toEqual(['parse', 'resolve', 'query', 'done']);
    expect(offline.findings).toEqual(expected.findings);
    expect(offline.summary).toEqual(expected.summary);
    const w = offline.warnings.find((x) => x.code === 'offline-mode')!;
    expect(w.message).toContain('npm: 2026-03-01T00:00:00Z');
    expect(w.message).toContain('unresolved manifest ranges are not scanned');
  });

  it('does not resolve manifest ranges offline', async () => {
    const db = new OfflineDatabase([buildOfflineIndex('npm', [lodashRecord])]);
    const result = await scanFiles(new FsFileProvider(join(FIXTURES, 'npm/manifest-only')), {
      fetch: async () => json({}, 500),
      offline: { query: (e, n, v) => db.query(e, n, v) },
    });
    expect(result.findings).toEqual([]);
    expect(result.warnings.some((x) => x.code === 'unresolved-version')).toBe(true);
    expect(result.warnings.find((x) => x.code === 'offline-mode')!.message).not.toContain('as of');
  });

  it('reports missing ecosystems only when queried, via ScanResult.warnings', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'vs-off-')), 'db'); // empty: no index files
    const scanNpm = () =>
      scanFiles(new FsFileProvider(join(FIXTURES, 'npm/lock-v3-express')), {
        fetch: async () => json({}, 500),
        offline: new LazyOfflineDatabase(dir),
      });
    const result = await scanNpm();
    const missing = result.warnings.filter((x) => x.code === 'offline-missing-ecosystem');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.message).toContain('No offline data for npm');
  });
});
