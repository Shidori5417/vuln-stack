import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';
import AjvDraft04Module from 'ajv-draft-04';
import { describe, expect, it } from 'vitest';
import {
  applyIgnores,
  exceedsThreshold,
  ignoreRulesFromIds,
  parseIgnoreFile,
} from '../src/ignore.js';
import { formatJson } from '../src/report/json.js';
import { formatSarif, toSarif } from '../src/report/sarif.js';
import { scanFiles, scanManual } from '../src/scan.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import type { ScanResult } from '../src/model/types.js';
import { CRITICAL_VECTOR, fakeOsv, FIXTURES, ghsa, HIGH_VECTOR, LOW_VECTOR } from './helpers.js';
import { join } from 'node:path';

// CJS modules: under NodeNext the class sits on `.default`.
const Ajv2020 = Ajv2020Module.default;
const AjvDraft04 = AjvDraft04Module.default;

const schemaPath = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

async function sampleScan(): Promise<ScanResult> {
  const { fetch } = fakeOsv({
    affected: {
      'npm:body-parser@1.19.0': ['GHSA-body'],
      'npm:minimist@1.2.0': ['GHSA-mini'],
      'npm:lodash@4.17.15': ['GHSA-lo1', 'GHSA-lo2'],
    },
    records: [
      ghsa(
        'GHSA-body',
        'body-parser',
        { fixed: '1.20.3' },
        { cve: 'CVE-2024-45590', vector: HIGH_VECTOR },
      ),
      ghsa(
        'GHSA-mini',
        'minimist',
        { fixed: '1.2.6' },
        { cve: 'CVE-2021-44906', vector: CRITICAL_VECTOR },
      ),
      ghsa(
        'GHSA-lo1',
        'lodash',
        { fixed: '4.17.19' },
        { cve: 'CVE-2020-8203', vector: LOW_VECTOR },
      ),
      { ...ghsa('GHSA-lo2', 'lodash', {}, { label: 'MODERATE' }), details: 'Long text' },
    ],
  });
  return scanFiles(new FsFileProvider(join(FIXTURES, 'npm/lock-v3-express')), {
    fetch,
    kev: false,
    epss: false,
  });
}

describe('ignore rules', () => {
  it('parses the ignore file format', () => {
    const { rules, warnings } = parseIgnoreFile(
      [
        '# Accepted risks',
        'CVE-2021-44906 minimist until=2099-01-01  # dev-only CLI parsing',
        'GHSA-lo2   # no fix upstream yet',
        'CVE-2020-8203',
        'CVE-1 pkg extra  # x',
        '',
      ].join('\n'),
    );
    expect(rules).toEqual([
      {
        id: 'CVE-2021-44906',
        package: 'minimist',
        until: '2099-01-01',
        reason: 'dev-only CLI parsing',
        source: '.vulnstackignore:2',
      },
      { id: 'GHSA-lo2', reason: 'no fix upstream yet', source: '.vulnstackignore:3' },
      { id: 'CVE-2020-8203', source: '.vulnstackignore:4' },
      { id: 'CVE-1', package: 'pkg', reason: 'x', source: '.vulnstackignore:5' },
    ]);
    expect(warnings.map((w) => [w.code, w.file])).toEqual([
      ['ignore-no-reason', '.vulnstackignore:4'],
      ['ignore-syntax', '.vulnstackignore:5'],
    ]);
    expect(ignoreRulesFromIds(['GHSA-a, CVE-b', '', 'X'])).toEqual([
      { id: 'GHSA-a', source: '--ignore' },
      { id: 'CVE-b', source: '--ignore' },
      { id: 'X', source: '--ignore' },
    ]);
  });

  it('suppresses matching findings by any alias, honours package limits and expiry', async () => {
    const scan = await sampleScan();
    const result = applyIgnores(
      scan,
      [
        { id: 'ghsa-mini', source: 'a' }, // alias, case-insensitive
        { id: 'CVE-2024-45590', package: 'not-body-parser', source: 'b' }, // wrong package
        { id: 'CVE-2020-8203', until: '2020-01-01', source: 'c' }, // expired
        { id: 'CVE-unused', source: 'd' },
      ],
      '2026-10-16',
    );
    expect(result.ignored.map((i) => i.finding.vulnerability.id)).toEqual(['CVE-2021-44906']);
    expect(result.findings).toHaveLength(3);
    expect(result.summary.findings).toBe(3);
    expect(result.summary.bySeverity.critical).toBe(0);
    expect(result.summary.vulnerableDependencies).toBe(2);
    expect(result.warnings.map((w) => w.code).sort()).toEqual([
      'ignore-expired',
      'ignore-unused',
      'ignore-unused',
    ]);
  });

  it('decides the fail threshold', async () => {
    const { findings } = await sampleScan();
    expect(exceedsThreshold(findings, 'critical')).toBe(true);
    const nonCritical = findings.filter((f) => f.vulnerability.severity !== 'critical');
    expect(exceedsThreshold(nonCritical, 'critical')).toBe(false);
    expect(exceedsThreshold(nonCritical, 'high')).toBe(true);
    const lowOnly = findings.filter((f) => f.vulnerability.severity === 'low');
    expect(exceedsThreshold(lowOnly, 'medium')).toBe(false);
    expect(exceedsThreshold(lowOnly, 'low')).toBe(true);
    const unknown = [
      {
        ...lowOnly[0]!,
        vulnerability: { ...lowOnly[0]!.vulnerability, severity: 'unknown' as const },
      },
    ];
    expect(exceedsThreshold(unknown, 'low')).toBe(false);
    expect(exceedsThreshold(unknown, 'any')).toBe(true);
    expect(exceedsThreshold([], 'any')).toBe(false);
  });
});

describe('JSON report', () => {
  it('matches the documented schema, including ignored findings', async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(
      JSON.parse(readFileSync(schemaPath('../../../docs/report-schema.json'), 'utf8')),
    );
    const scan = applyIgnores(await sampleScan(), [{ id: 'GHSA-mini', reason: 'r', source: 's' }]);
    const report = JSON.parse(formatJson(scan));
    expect(validate(report), JSON.stringify(validate.errors, null, 2)).toBe(true);
    const manual = JSON.parse(
      formatJson(await scanManual('a@1', { fetch: fakeOsv({ affected: {}, records: [] }).fetch })),
    );
    expect(validate(manual), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('SARIF report', () => {
  const ajv = new AjvDraft04({ allErrors: true, strict: false });
  const validate = ajv.compile(
    JSON.parse(readFileSync(schemaPath('./schemas/sarif-schema-2.1.0.json'), 'utf8')),
  );

  it('is valid SARIF 2.1.0 with one rule per vulnerability', async () => {
    const scan = applyIgnores(await sampleScan(), [
      { id: 'CVE-2020-8203', reason: 'accepted', source: '.vulnstackignore:1' },
    ]);
    const sarif = JSON.parse(formatSarif(scan));
    expect(validate(sarif), JSON.stringify(validate.errors, null, 2)).toBe(true);

    const run = sarif.runs[0];
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id).sort()).toEqual([
      'CVE-2020-8203',
      'CVE-2021-44906',
      'CVE-2024-45590',
      'GHSA-lo2',
    ]);
    const critical = run.tool.driver.rules.find((r: { id: string }) => r.id === 'CVE-2021-44906');
    expect(critical.properties['security-severity']).toBe('9.8');
    expect(critical.defaultConfiguration.level).toBe('error');
    const moderate = run.tool.driver.rules.find((r: { id: string }) => r.id === 'GHSA-lo2');
    expect(moderate.properties['security-severity']).toBe('5.5');

    expect(run.results).toHaveLength(4);
    const bodyParser = run.results.find((r: { ruleId: string }) => r.ruleId === 'CVE-2024-45590');
    expect(bodyParser.locations[0].physicalLocation.artifactLocation.uri).toBe('package-lock.json');
    expect(bodyParser.message.text).toContain('pulled in via my-app > express > body-parser');
    expect(bodyParser.message.text).toContain('Upgrade to 1.20.3.');
    expect(bodyParser.partialFingerprints.vulnstackFinding).toBe(
      '.|npm|body-parser|CVE-2024-45590',
    );
    const suppressed = run.results.find((r: { ruleId: string }) => r.ruleId === 'CVE-2020-8203');
    expect(suppressed.suppressions).toEqual([
      { kind: 'external', status: 'accepted', justification: 'accepted' },
    ]);
    const noFix = run.results.find((r: { ruleId: string }) => r.ruleId === 'GHSA-lo2');
    expect(noFix.message.text).toContain('No fixed version is available yet.');
  });

  it('handles manual input, warnings and suppressions without a reason', async () => {
    const { fetch } = fakeOsv({
      affected: { 'npm:minimist@0.0.8': ['GHSA-mini'] },
      records: [ghsa('GHSA-mini', 'minimist', { fixed: '1.2.6' }, { cve: 'CVE-2021-44906' })],
    });
    const scan = applyIgnores(
      await scanManual('minimist@0.0.8, ???', { fetch, kev: false, epss: false }),
      [{ id: 'CVE-2021-44906', source: '--ignore' }],
    );
    scan.warnings.push({ code: 'x', message: 'with file', file: 'package.json' });
    const sarif = toSarif(scan);
    expect(validate(sarif), JSON.stringify(validate.errors, null, 2)).toBe(true);
    const result = sarif.runs[0]!.results![0]!;
    expect(result.locations![0]!.physicalLocation!.artifactLocation!.uri).toBe('manual-input');
    expect(result.suppressions![0]!.justification).toBe('Ignored by --ignore');
    expect(result.message.text).toContain('(major upgrade)');
    expect(sarif.runs[0]!.invocations![0]!.toolExecutionNotifications).toHaveLength(2);
  });
});
