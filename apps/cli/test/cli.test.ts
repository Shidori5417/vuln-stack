import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryCache, type FetchFn } from '@vulnstack/core';
import { runCli } from '../src/program.js';
import type { CliIO } from '../src/io.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

/** OSV fake: minimist < 1.2.6 and express 4.17.1 are vulnerable. */
const fetch: FetchFn = async (url, init) => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (url.endsWith('/querybatch')) {
    const { queries } = JSON.parse(String(init!.body)) as {
      queries: { package: { name: string }; version: string }[];
    };
    return json({
      results: queries.map((q) => {
        if (q.package.name === 'minimist' && q.version.startsWith('1.2.0'))
          return { vulns: [{ id: 'GHSA-mini' }] };
        if (q.package.name === 'body-parser') return { vulns: [{ id: 'GHSA-body' }] };
        return {};
      }),
    });
  }
  const id = url.split('/').pop()!;
  const pkg = id === 'GHSA-mini' ? 'minimist' : 'body-parser';
  const fixed = id === 'GHSA-mini' ? '1.2.6' : '2.0.0';
  return json({
    id,
    aliases: [id === 'GHSA-mini' ? 'CVE-2021-44906' : 'CVE-2024-45590'],
    summary: `${pkg} is vulnerable`,
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
    affected: [
      {
        package: { ecosystem: 'npm', name: pkg },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }],
      },
    ],
  });
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

describe('vulnstack scan', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'vulnstack-cli-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('prints a findings table for a lock file', async () => {
    const t = makeIO();
    expect(await runCli(['scan', 'npm/lock-v3-express'], t.io)).toBe(0);
    const out = t.stdout();
    expect(out).toContain('my-app (package-lock.json)');
    expect(out).toContain('CVE-2021-44906');
    expect(out).toContain('my-app > express > body-parser');
    expect(out).toContain('breaking update');
    expect(out).toContain('safe patch');
    expect(out).toMatch(/2 vulnerabilities \(2 critical\) in 2 of 52 dependencies/);
    expect(out).not.toContain('\u001b['); // not a TTY → no colors
  });

  it('honours FORCE_COLOR', async () => {
    const t = makeIO({ env: { FORCE_COLOR: '1' } });
    await runCli(['scan', 'npm/lock-v3-express'], t.io);
    expect(t.stdout()).toContain('\u001b[');
  });

  it('shows a clean message when nothing is found', async () => {
    const t = makeIO();
    expect(await runCli(['scan', '--manual', 'react@18.3.1'], t.io)).toBe(0);
    expect(t.stdout()).toContain('✔ No known vulnerabilities found in 1 dependency.');
  });

  it('writes JSON to a file', async () => {
    const t = makeIO({ cwd: tmp });
    const code = await runCli(
      ['scan', join(FIXTURES, 'npm/lock-v3-express'), '-f', 'json', '-o', 'out.json', '--no-dev'],
      t.io,
    );
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(join(tmp, 'out.json'), 'utf8'));
    expect(report.summary.findings).toBe(1);
    expect(report.findings[0].dependency.name).toBe('body-parser');
    expect(t.stderr()).toContain('Report written to out.json');
    expect(t.stdout()).toBe('');
  });

  it('prints warnings to stderr', async () => {
    const t = makeIO();
    await runCli(['scan', 'npm/lock-v1'], t.io);
    expect(t.stderr()).toContain('my-fork');
  });

  it('shows progress on an interactive stderr', async () => {
    const t = makeIO();
    t.io.stderr.isTTY = true;
    await runCli(['scan', '--manual', 'minimist@1.2.0'], t.io);
    expect(t.stderr()).toContain('Querying OSV.dev');
  });

  it('fails with exit code 2 on bad input', async () => {
    const missing = makeIO();
    expect(await runCli(['scan', 'does-not-exist'], missing.io)).toBe(2);
    expect(missing.stderr()).toContain('does-not-exist is not a directory');

    const badFormat = makeIO();
    expect(await runCli(['scan', '-f', 'xml'], badFormat.io)).toBe(2);
    expect(badFormat.stderr()).toContain('Allowed choices are table, json');
  });

  it('reports network failures', async () => {
    const t = makeIO({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
      env: { DEBUG: '1' },
    });
    expect(await runCli(['scan', '--manual', 'a@1.0.0'], t.io)).toBe(2);
    expect(t.stderr()).toContain('Scan failed: fetch failed');
    expect(t.stderr()).toContain('at '); // stack in DEBUG mode
  });

  it('prints help and version', async () => {
    const help = makeIO();
    expect(await runCli(['--help'], help.io)).toBe(0);
    expect(help.stdout()).toContain('scan [options] [path]');
    const version = makeIO();
    expect(await runCli(['-v'], version.io)).toBe(0);
    expect(version.stdout()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

import { sourceOptions } from '../src/commands/scan.js';

describe('advisory source options', () => {
  const base = {
    format: 'table' as const,
    dev: true,
    cache: true,
    resolve: true,
    ghsa: true,
    nvdTimeout: 10,
    ignore: [],
  };

  it('enables GHSA from a token and NVD from an API key', () => {
    expect(sourceOptions(base, {})).toEqual({});
    expect(sourceOptions(base, { GITHUB_TOKEN: 'g' })).toEqual({ ghsa: { token: 'g' } });
    expect(sourceOptions(base, { VULNSTACK_GITHUB_TOKEN: 'v', GITHUB_TOKEN: 'g' }).ghsa).toEqual({
      token: 'v',
    });
    expect(sourceOptions({ ...base, ghsa: false }, { GITHUB_TOKEN: 'g' })).toEqual({});
    expect(sourceOptions(base, { NVD_API_KEY: 'k' })).toEqual({
      nvd: { maxWaitMs: 10_000, apiKey: 'k' },
    });
    expect(sourceOptions({ ...base, nvd: false }, { NVD_API_KEY: 'k' })).toEqual({});
    expect(sourceOptions({ ...base, nvd: true, nvdTimeout: 2 }, {})).toEqual({
      nvd: { maxWaitMs: 2000 },
    });
  });

  it('validates --nvd-timeout', async () => {
    const t = makeIO();
    expect(await runCli(['scan', '--nvd-timeout', 'soon'], t.io)).toBe(2);
    expect(t.stderr()).toContain('must be a non-negative number');
  });
});

import { copyFileSync, writeFileSync } from 'node:fs';
import { loadIgnoreRules } from '../src/commands/scan.js';

describe('reports, thresholds and ignores', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vulnstack-cli3-'));
  copyFileSync(
    join(FIXTURES, 'npm/lock-v3-express/package-lock.json'),
    join(dir, 'package-lock.json'),
  );
  copyFileSync(join(FIXTURES, 'npm/lock-v3-express/package.json'), join(dir, 'package.json'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('fails with exit code 1 at or above --fail-on', async () => {
    const critical = makeIO();
    expect(
      await runCli(['scan', 'npm/lock-v3-express', '--fail-on', 'critical'], critical.io),
    ).toBe(1);
    const quiet = makeIO();
    expect(await runCli(['scan', '--manual', 'react@18.3.1', '--fail-on', 'low'], quiet.io)).toBe(
      0,
    );
    const bad = makeIO();
    expect(await runCli(['scan', '--fail-on', 'severe'], bad.io)).toBe(2);
  });

  it('ignores ids from flags so --fail-on passes', async () => {
    const t = makeIO();
    const code = await runCli(
      [
        'scan',
        'npm/lock-v3-express',
        '--fail-on',
        'critical',
        '--ignore',
        'CVE-2021-44906',
        '--ignore',
        'GHSA-body,CVE-x',
      ],
      t.io,
    );
    expect(code).toBe(0);
    expect(t.stdout()).toContain('✔ No known vulnerabilities found in 52 dependencies.');
    expect(t.stdout()).toContain('2 findings ignored by your ignore rules.');
    expect(t.stderr()).toContain('Ignore rule for CVE-x matched nothing');
  });

  it('reads .vulnstackignore from the scanned folder and reports expiry', async () => {
    writeFileSync(
      join(dir, '.vulnstackignore'),
      'CVE-2021-44906 minimist  # dev-only\nGHSA-body until=2000-01-01  # old\n',
    );
    const t = makeIO();
    expect(await runCli(['scan', dir, '-f', 'json', '--fail-on', 'high'], t.io)).toBe(1);
    const report = JSON.parse(t.stdout());
    expect(
      report.ignored.map(
        (i: { finding: { vulnerability: { id: string } } }) => i.finding.vulnerability.id,
      ),
    ).toEqual(['CVE-2021-44906']);
    expect(
      report.findings.map((f: { vulnerability: { id: string } }) => f.vulnerability.id),
    ).toEqual(['CVE-2024-45590']);
    expect(t.stderr()).toContain('expired on 2000-01-01');
    expect(t.stderr()).toContain('Found vulnerabilities at or above "high"');
  });

  it('requires an explicit --ignore-file to exist', async () => {
    const t = makeIO();
    expect(await runCli(['scan', 'npm/lock-v3-express', '--ignore-file', 'nope.txt'], t.io)).toBe(
      2,
    );
    expect(t.stderr()).toContain('Cannot read ignore file nope.txt');
    expect(await loadIgnoreRules({ ignore: ['A'] }, join(dir, 'missing'), dir)).toEqual({
      rules: [{ id: 'A', source: '--ignore' }],
      warnings: [],
    });
  });

  it('writes SARIF', async () => {
    const t = makeIO();
    expect(await runCli(['scan', 'npm/lock-v3-express', '-f', 'sarif'], t.io)).toBe(0);
    const sarif = JSON.parse(t.stdout());
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results).toHaveLength(2);
  });

  it('writes PDF to a file and refuses to print it to a terminal', async () => {
    const t = makeIO({ cwd: dir });
    expect(await runCli(['scan', '.', '-f', 'pdf', '-o', 'report.pdf'], t.io)).toBe(0);
    expect(readFileSync(join(dir, 'report.pdf'), 'latin1')).toMatch(/^%PDF-1\.4/);

    const tty = makeIO();
    tty.io.stdout.isTTY = true;
    expect(await runCli(['scan', 'npm/lock-v3-express', '-f', 'pdf'], tty.io)).toBe(2);
    expect(tty.stderr()).toContain('PDF output is binary');

    const piped = makeIO();
    expect(await runCli(['scan', '--manual', 'minimist@1.2.0', '-f', 'pdf'], piped.io)).toBe(0);
  });
});
