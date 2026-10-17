import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  ecosystemsIn,
  filterFindings,
  filtersEqual,
  idUrl,
  sortFindings,
} from '@/lib/filter';
import { isValidRepoInput } from '@/lib/api';
import { acceptFiles, formatBytes, isSupportedFile } from '@/lib/files';
import { sampleFindings } from './sample';

const ids = (fs: { vulnerability: { id: string } }[]) => fs.map((f) => f.vulnerability.id);

describe('filterFindings', () => {
  it('filters by severity, ecosystem, relation, fixability and text', () => {
    expect(filterFindings(sampleFindings, DEFAULT_FILTERS)).toHaveLength(4);
    expect(
      ids(filterFindings(sampleFindings, { ...DEFAULT_FILTERS, severities: ['critical', 'low'] })),
    ).toEqual(['CVE-2021-0001', 'GHSA-xxxx-0004']);
    expect(ids(filterFindings(sampleFindings, { ...DEFAULT_FILTERS, ecosystem: 'PyPI' }))).toEqual([
      'CVE-2020-0003',
    ]);
    expect(
      ids(filterFindings(sampleFindings, { ...DEFAULT_FILTERS, relation: 'transitive' })),
    ).toEqual(['CVE-2024-0002']);
    expect(filterFindings(sampleFindings, { ...DEFAULT_FILTERS, relation: 'direct' })).toHaveLength(
      3,
    );
    expect(filterFindings(sampleFindings, { ...DEFAULT_FILTERS, fixableOnly: true })).toHaveLength(
      3,
    );
    expect(ids(filterFindings(sampleFindings, { ...DEFAULT_FILTERS, query: 'PARENT' }))).toEqual([
      'CVE-2024-0002',
    ]);
    expect(ids(filterFindings(sampleFindings, { ...DEFAULT_FILTERS, query: 'ghsa-0001' }))).toEqual(
      ['CVE-2021-0001'],
    );
  });

  it('sorts by severity, package and id', () => {
    const shuffled = [...sampleFindings].reverse();
    expect(ids(sortFindings(shuffled, 'severity'))).toEqual([
      'CVE-2021-0001',
      'CVE-2024-0002',
      'CVE-2020-0003',
      'GHSA-xxxx-0004',
    ]);
    expect(sortFindings(shuffled, 'package').map((f) => f.dependency.name)).toEqual([
      'body-parser',
      'django',
      'lodash',
      'minimist',
    ]);
    expect(ids(sortFindings(shuffled, 'id', true))[0]).toBe('GHSA-xxxx-0004');
  });

  it('lists ecosystems and builds advisory links', () => {
    expect(ecosystemsIn(sampleFindings)).toEqual(['PyPI', 'npm']);
    expect(idUrl('CVE-1')).toBe('https://nvd.nist.gov/vuln/detail/CVE-1');
    expect(idUrl('GHSA-1')).toBe('https://github.com/advisories/GHSA-1');
    expect(idUrl('PYSEC-1')).toBe('https://osv.dev/vulnerability/PYSEC-1');
    expect(idUrl('cve-2024-1')).toBe('https://nvd.nist.gov/vuln/detail/CVE-2024-1');
    expect(idUrl('ghsa-abcd')).toBe('https://github.com/advisories/GHSA-ABCD');
    expect(idUrl('X/1?a')).toBe('https://osv.dev/vulnerability/X%2F1%3Fa');
  });
});

describe('upload helpers', () => {
  it('accepts supported files, skips vendored folders and dedupes', () => {
    const file = (path: string) => ({ path, content: '{}', size: 2 });
    const { accepted, rejected } = acceptFiles([
      file('app/package-lock.json'),
      file('app/node_modules/x/package.json'),
      file('README.md'),
      file('svc/Api.csproj'),
      file('app/package-lock.json'),
      file('py/requirements-dev.txt'),
    ]);
    expect(accepted.map((f) => f.path)).toEqual([
      'app/package-lock.json',
      'py/requirements-dev.txt',
      'svc/Api.csproj',
    ]);
    expect(rejected).toEqual(['README.md']);
    expect(isSupportedFile('libs.versions.toml')).toBe(true);
    expect(isSupportedFile('Cargo.lock')).toBe(false);
  });

  it('formats sizes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('filtersEqual', () => {
  it('compares by value', () => {
    expect(filtersEqual({ ...DEFAULT_FILTERS, severities: [] }, DEFAULT_FILTERS)).toBe(true);
    expect(filtersEqual({ ...DEFAULT_FILTERS, query: 'a' }, DEFAULT_FILTERS)).toBe(false);
    expect(filtersEqual({ ...DEFAULT_FILTERS, severities: ['low'] }, DEFAULT_FILTERS)).toBe(false);
    expect(
      filtersEqual(
        { ...DEFAULT_FILTERS, severities: ['low', 'high'] },
        { ...DEFAULT_FILTERS, severities: ['low', 'high'] },
      ),
    ).toBe(true);
  });
});

describe('isValidRepoInput', () => {
  it('accepts owner/repo and github URLs only', () => {
    expect(isValidRepoInput('vercel/next.js')).toBe(true);
    expect(isValidRepoInput('https://github.com/o/r/tree/main/p')).toBe(true);
    expect(isValidRepoInput('nonsense')).toBe(false);
    expect(isValidRepoInput('http://github.com/o/r')).toBe(false);
    expect(isValidRepoInput('https://gitlab.com/o/r')).toBe(false);
  });
});
