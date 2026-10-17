import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryCache, type FetchFn } from '@vulnstack/core';
import { runCli } from '../src/program.js';
import type { CliIO } from '../src/io.js';
import { makeZip } from './offline-zip.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

const record = (id: string, name: string, fixed: string, eco = 'npm') => ({
  id,
  aliases: [`CVE-${id}`],
  summary: `${name} is vulnerable`,
  affected: [
    {
      package: { ecosystem: eco, name },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }],
    },
  ],
});

const dumps: Record<string, Uint8Array> = {
  npm: makeZip([
    { name: 'GHSA-mini.json', data: JSON.stringify(record('GHSA-mini', 'minimist', '1.2.6')) },
    { name: 'GHSA-body.json', data: JSON.stringify(record('GHSA-body', 'body-parser', '1.20.3')) },
  ]),
  Go: makeZip([{ name: 'GO-1.json', data: JSON.stringify(record('GO-1', 'x/y', '2.0.0', 'Go')) }]),
};

/** Serves the dumps and fails on anything else (so scans prove they stay offline). */
const requested: string[] = [];
const fetch: FetchFn = async (url) => {
  requested.push(url);
  const eco = /\/([^/]+)\/all\.zip$/.exec(url)?.[1];
  const zip = eco && dumps[eco];
  if (!zip) return new Response('missing', { status: 404 });
  return new Response(zip, { headers: { etag: `"${eco}"` } });
};

function makeIO(overrides: Partial<CliIO> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    stdout: { write: (s: string) => out.push(s), columns: 160 },
    stderr: { write: (s: string) => err.push(s) },
    cwd: FIXTURES,
    env: {},
    fetch,
    cache: new MemoryCache(),
    ...overrides,
  };
  return { io, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('vulnstack db', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'vs-cli-off-')), 'db');

  it('update downloads the selected ecosystems and prints a summary', async () => {
    const t = makeIO();
    const code = await runCli(['db', 'update', '--ecosystem', 'npm', 'go', '--dir', dir], t.io);
    expect(code).toBe(0);
    expect(requested.filter((u) => u.endsWith('all.zip'))).toEqual([
      'https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip',
      'https://osv-vulnerabilities.storage.googleapis.com/Go/all.zip',
    ]);
    expect(t.stdout()).toMatch(/npm\s+2 records/);
    expect(t.stdout()).toMatch(/Go\s+1 records/);
    expect(t.stderr()).toContain('npm: downloading');

    const again = makeIO({ fetch: async () => new Response(null, { status: 304 }) });
    await runCli(['db', 'update', '--ecosystem', 'npm,Go', '--dir', dir], again.io);
    expect(again.stdout()).toMatch(/npm\s+unchanged/);
  });

  it('update rejects unknown ecosystems', async () => {
    const t = makeIO();
    expect(await runCli(['db', 'update', '--ecosystem', 'cobol', '--dir', dir], t.io)).toBe(2);
    expect(t.stderr()).toContain('Unknown ecosystem "cobol"');
  });

  it('status shows build info and warns about stale data', async () => {
    const t = makeIO();
    await runCli(['db', 'status', '--dir', dir], t.io);
    expect(t.stdout()).toMatch(/npm\s+built .*\(0 d ago\)\s+2 records/);
    expect(t.stdout()).toMatch(/PyPI\s+not downloaded/);
    expect(t.stdout()).not.toContain('older than');

    const old = join(mkdtempSync(join(tmpdir(), 'vs-cli-off-')), 'db');
    mkdirSync(old);
    writeFileSync(
      join(old, 'meta.json'),
      JSON.stringify({
        npm: { builtAt: '2020-01-01T00:00:00.000Z', records: 3, bytes: 10, packages: 1 },
      }),
    );
    const s = makeIO();
    await runCli(['db', 'status', '--dir', old], s.io);
    expect(s.stdout()).toContain('older than 7 days');

    const empty = makeIO();
    await runCli(['db', 'status', '--dir', join(old, 'none')], empty.io);
    expect(empty.stdout()).toContain('Nothing downloaded yet');
  });

  it('scan --offline reports findings without network and warns for missing ecosystems', async () => {
    const before = requested.length;
    const t = makeIO({
      fetch: async () => {
        throw new Error('network used');
      },
    });
    const code = await runCli(
      ['scan', 'npm/lock-v3-express', '--offline', '--offline-dir', dir, '--format', 'json'],
      t.io,
    );
    expect(code).toBe(0);
    expect(requested.length).toBe(before);
    const report = JSON.parse(t.stdout()) as { findings: { vulnerability: { id: string } }[] };
    expect(report.findings.map((f) => f.vulnerability.id).sort()).toEqual([
      'CVE-GHSA-body',
      'CVE-GHSA-mini',
    ]);
    expect(t.stderr()).toContain('Offline mode: advisory data is local');
    // Only npm was queried, so the missing PyPI index must not be reported.
    expect(t.stderr()).not.toContain('No offline data');

    const manual = makeIO();
    await runCli(['scan', '--manual', 'Django@3.0', '--offline', '--offline-dir', dir], manual.io);
    expect(manual.stderr()).toContain('No offline data for PyPI');
    expect(manual.stderr()).toContain('vulnstack db update --ecosystem PyPI');

    const manualHit = makeIO();
    const hit = await runCli(
      ['scan', '--manual', 'minimist@1.2.0', '--offline', '--offline-dir', dir],
      manualHit.io,
    );
    expect(hit).toBe(0);
    expect(manualHit.stdout()).toContain('GHSA-mini');
  });

  it('scan --offline warns once for a queried ecosystem whose index is missing', async () => {
    const empty = join(mkdtempSync(join(tmpdir(), 'vs-cli-off-')), 'db');
    const t = makeIO();
    const code = await runCli(
      ['scan', 'npm/lock-v3-express', '--offline', '--offline-dir', empty],
      t.io,
    );
    expect(code).toBe(0);
    expect(t.stderr().match(/No offline data for npm/g)).toHaveLength(1);
    expect(t.stderr()).not.toContain('No offline data for PyPI');
  });

  it('scan --offline is incompatible with --url', async () => {
    const t = makeIO();
    const code = await runCli(
      ['scan', '--url', 'example.com', '--offline', '--i-own-this-site'],
      t.io,
    );
    expect(code).toBe(2);
    expect(t.stderr()).toContain('--offline cannot be combined with --url');
  });
});
