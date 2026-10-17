import { describe, expect, it } from 'vitest';
import { MemoryFileProvider } from '../src/sources/file-provider.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { scanFiles, scanManual, scanSubprojects } from '../src/scan.js';
import { formatJson } from '../src/report/json.js';
import { CRITICAL_VECTOR, FIXTURES, fakeOsv, ghsa, HIGH_VECTOR, LOW_VECTOR } from './helpers.js';
import { join } from 'node:path';

const expressOsv = () =>
  fakeOsv({
    affected: {
      'npm:express@4.17.1': ['GHSA-qw6h-vgh9-j6wx'],
      'npm:body-parser@1.19.0': ['GHSA-qwcr-r2fm-qrc7'],
      'npm:lodash@4.17.15': ['GHSA-35jh-r3h4-6jhm', 'GHSA-p6mc-m468-83gw'],
      'npm:minimist@1.2.0': ['GHSA-xvch-5gv4-984h'],
    },
    records: [
      ghsa(
        'GHSA-qw6h-vgh9-j6wx',
        'express',
        { fixed: '4.20.0' },
        { cve: 'CVE-2024-43796', vector: LOW_VECTOR },
      ),
      ghsa(
        'GHSA-qwcr-r2fm-qrc7',
        'body-parser',
        { fixed: '1.20.3' },
        { cve: 'CVE-2024-45590', vector: HIGH_VECTOR },
      ),
      ghsa(
        'GHSA-35jh-r3h4-6jhm',
        'lodash',
        { fixed: '4.17.21' },
        { cve: 'CVE-2021-23337', label: 'HIGH' },
      ),
      ghsa(
        'GHSA-p6mc-m468-83gw',
        'lodash',
        { fixed: '4.17.19' },
        { cve: 'CVE-2020-8203', label: 'HIGH' },
      ),
      ghsa(
        'GHSA-xvch-5gv4-984h',
        'minimist',
        { fixed: '1.2.6' },
        { cve: 'CVE-2021-44906', vector: CRITICAL_VECTOR },
      ),
    ],
  });

describe('scanFiles', () => {
  it('scans a real package-lock end to end', async () => {
    const { fetch, calls } = expressOsv();
    const phases: string[] = [];
    const result = await scanFiles(new FsFileProvider(join(FIXTURES, 'npm/lock-v3-express')), {
      fetch,
      kev: false,
      epss: false,
      onProgress: (p) => phases.push(p),
    });

    expect(phases).toEqual(['parse', 'resolve', 'query', 'details', 'done']);
    expect(result.summary).toEqual({
      subprojects: 1,
      dependencies: 52,
      vulnerableDependencies: 4,
      findings: 5,
      bySeverity: { critical: 1, high: 3, medium: 0, low: 1, unknown: 0 },
    });
    // severity, then score, then direct-first
    expect(result.findings.map((f) => [f.vulnerability.id, f.vulnerability.severity])).toEqual([
      ['CVE-2021-44906', 'critical'],
      ['CVE-2024-45590', 'high'],
      ['CVE-2020-8203', 'high'],
      ['CVE-2021-23337', 'high'],
      ['CVE-2024-43796', 'low'],
    ]);
    const bodyParser = result.findings[1]!;
    expect(bodyParser.chain).toEqual(['my-app', 'express', 'body-parser']);
    expect(bodyParser.dependency.isDirect).toBe(false);
    expect(bodyParser.remediation).toEqual({ type: 'safe-patch', fixedVersion: '1.20.3' });
    expect(bodyParser.fingerprint).toBe('.|npm|body-parser|CVE-2024-45590');
    expect(bodyParser.vulnerability.aliases).toEqual(['CVE-2024-45590', 'GHSA-qwcr-r2fm-qrc7']);
    // one querybatch for 52 packages + 5 detail calls
    expect(calls.filter((c) => c.url.endsWith('querybatch'))).toHaveLength(1);
    expect(calls).toHaveLength(6);
  });

  it('can leave dev dependencies out', async () => {
    const { fetch } = expressOsv();
    const result = await scanFiles(new FsFileProvider(join(FIXTURES, 'npm/lock-v3-express')), {
      fetch,
      includeDev: false,
    });
    expect(result.findings.some((f) => f.dependency.name === 'minimist')).toBe(false);
    expect(result.summary.dependencies).toBe(51);
  });

  it('resolves manifest ranges through the registry with medium confidence', async () => {
    const { fetch } = fakeOsv({
      affected: { 'npm:lodash@4.17.15': ['GHSA-p6mc-m468-83gw'] },
      records: [ghsa('GHSA-p6mc-m468-83gw', 'lodash', { fixed: '4.17.19' })],
      registry: {
        lodash: { versions: ['4.17.10', '4.17.15', '4.18.0'], latest: '4.18.0' },
        minimist: { versions: ['1.2.0'] },
        'left-pad': { versions: ['1.3.0'] },
      },
    });
    const result = await scanFiles(new FsFileProvider(join(FIXTURES, 'npm/manifest-only')), {
      fetch,
    });
    const lodash = result.findings[0]!;
    expect(lodash.dependency).toMatchObject({
      name: 'lodash',
      version: '4.17.15',
      declaredRange: '~4.17.10',
      confidence: 'medium',
    });
    expect(result.warnings.map((w) => w.code).sort()).toEqual([
      'no-lockfile',
      'non-registry-version',
    ]);
    expect(result.summary.dependencies).toBe(3);
  });

  it('drops dependencies it cannot resolve, with a warning', async () => {
    const { fetch } = fakeOsv({ affected: {}, records: [], registry: {} });
    const provider = new MemoryFileProvider({
      'package.json': JSON.stringify({ dependencies: { ghost: '^1.0.0' } }),
    });
    const result = await scanFiles(provider, { fetch });
    expect(result.summary.dependencies).toBe(0);
    expect(result.warnings.map((w) => w.code)).toContain('unresolved-version');

    const offline = await scanFiles(provider, { fetch, resolveRanges: false });
    expect(offline.warnings.map((w) => w.code)).toContain('unresolved-version');
  });

  it('dedupes registry lookups for the same range', async () => {
    const { fetch, calls } = fakeOsv({
      affected: {},
      records: [],
      registry: { a: { versions: ['1.0.0'] } },
    });
    const provider = new MemoryFileProvider({
      'x/package.json': JSON.stringify({ dependencies: { a: '^1.0.0' } }),
      'y/package.json': JSON.stringify({ dependencies: { a: '^1.0.0' } }),
    });
    await scanFiles(provider, { fetch });
    expect(calls.filter((c) => c.url.includes('registry'))).toHaveLength(1);
  });
});

describe('scanManual', () => {
  it('scans free text and reports unparseable entries', async () => {
    const { fetch } = expressOsv();
    const result = await scanManual('express@4.17.1, what is this', {
      fetch,
      kev: false,
      epss: false,
    });
    expect(result.findings.map((f) => f.chain)).toEqual([['manual', 'express']]);
    expect(result.warnings.map((w) => w.code)).toEqual(['manual-parse-error']);
  });

  it('works with nothing to scan', async () => {
    const result = await scanSubprojects([], {
      fetch: async () => {
        throw new Error('no network expected');
      },
    });
    expect(result.summary.findings).toBe(0);
  });
});

describe('JSON report', () => {
  it('serialises graphs into plain arrays', async () => {
    const { fetch } = expressOsv();
    const result = await scanManual('express@4.17.1', { fetch });
    const report = JSON.parse(formatJson(result));
    expect(report.schemaVersion).toBe(1);
    expect(report.subprojects[0]).toMatchObject({
      path: 'manual',
      ecosystem: 'npm',
      root: 'manual',
    });
    expect(report.subprojects[0].dependencies[0].name).toBe('express');
    expect(report.findings[0].vulnerability.id).toBe('CVE-2024-43796');
  });
});
