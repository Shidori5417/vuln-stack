import { describe, expect, it } from 'vitest';
import { advisoryUrl, canonicalId, mergeRecords } from '../src/advisories/merge.js';
import type { OsvRecord } from '../src/advisories/osv.js';
import { CRITICAL_VECTOR, ghsa, LOW_VECTOR } from './helpers.js';

describe('mergeRecords', () => {
  it('merges records linked through aliases and prefers the CVE id', () => {
    const a = ghsa(
      'GHSA-aaaa',
      'x',
      { fixed: '1.0.1' },
      { cve: 'CVE-2024-1', summary: 'from ghsa' },
    );
    const b: OsvRecord = {
      id: 'CVE-2024-1',
      aliases: ['GHSA-aaaa'],
      details: 'Long details\nmore',
      severity: [{ type: 'CVSS_V3', score: LOW_VECTOR }],
      references: [
        { type: 'WEB', url: 'https://example.com' },
        { type: 'ADVISORY', url: 'https://github.com/advisories/GHSA-aaaa' },
      ],
      published: '2023-01-01T00:00:00Z',
    };
    const c = ghsa('GHSA-other', 'x', { fixed: '2.0.0' });

    const merged = mergeRecords([b, a, c]);
    expect(merged).toHaveLength(2);
    const one = merged.find((v) => v.id === 'CVE-2024-1')!;
    expect(one.aliases).toEqual(['CVE-2024-1', 'GHSA-aaaa']);
    expect(one.summary).toBe('from ghsa');
    expect(one.details).toBe('Long details\nmore');
    expect(one.cvss).toMatchObject({ source: 'osv', score: 3.1 });
    expect(one.severity).toBe('low');
    expect(one.references).toHaveLength(2);
    expect(one.published).toBe('2023-01-01T00:00:00Z');
    expect(one.cwes).toEqual(['CWE-79']);
    expect(one.affected).toHaveLength(1);
  });

  it('takes the GHSA vector first and falls back to labels', () => {
    const [withVector] = mergeRecords([ghsa('GHSA-v', 'x', {}, { vector: CRITICAL_VECTOR })]);
    expect(withVector!.cvss).toMatchObject({ source: 'ghsa', score: 9.8 });
    expect(withVector!.severity).toBe('critical');

    const [labelOnly] = mergeRecords([ghsa('GHSA-l', 'x', {}, { label: 'HIGH' })]);
    expect(labelOnly!.cvss).toBeUndefined();
    expect(labelOnly!.severity).toBe('high');
  });

  it('uses per-affected severity and the first details line as summary', () => {
    const [v] = mergeRecords([
      {
        id: 'PYSEC-1',
        details: 'First line\nsecond',
        affected: [
          {
            package: { ecosystem: 'PyPI', name: 'p' },
            severity: [{ type: 'CVSS_V3', score: CRITICAL_VECTOR }],
          },
          {},
        ],
      },
    ]);
    expect(v!.summary).toBe('First line');
    expect(v!.cvss!.score).toBe(9.8);
    expect(v!.affected).toEqual([{ ecosystem: 'PyPI', name: 'p', ranges: [], versions: [] }]);
    expect(v!.severity).toBe('critical');
  });

  it('handles records without summary or severity', () => {
    const [v] = mergeRecords([{ id: 'OSV-1' }]);
    expect(v).toMatchObject({ id: 'OSV-1', summary: '', severity: 'unknown', references: [] });
  });
});

describe('ids', () => {
  it('ranks CVE > GHSA > others', () => {
    expect(canonicalId(['PYSEC-1', 'GHSA-z', 'CVE-2'])).toBe('CVE-2');
    expect(canonicalId(['PYSEC-1', 'GHSA-z'])).toBe('GHSA-z');
    expect(canonicalId(['PYSEC-2', 'PYSEC-1'])).toBe('PYSEC-1');
  });

  it('builds advisory URLs', () => {
    expect(advisoryUrl('CVE-2024-1')).toBe('https://nvd.nist.gov/vuln/detail/CVE-2024-1');
    expect(advisoryUrl('GHSA-x')).toBe('https://github.com/advisories/GHSA-x');
    expect(advisoryUrl('PYSEC-1')).toBe('https://osv.dev/vulnerability/PYSEC-1');
  });
});
