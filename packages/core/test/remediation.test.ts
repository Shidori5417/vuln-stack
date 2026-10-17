import { describe, expect, it } from 'vitest';
import { npmVersioning } from '../src/ecosystems/npm/versioning.js';
import { mergeRecords } from '../src/advisories/merge.js';
import { computeRemediation, evaluateRange } from '../src/remediation.js';
import type { Dependency, Vulnerability } from '../src/model/types.js';
import { ghsa } from './helpers.js';

const dep = (name: string, version: string): Dependency => ({
  ecosystem: 'npm',
  name,
  version,
  isDirect: true,
  sourceFile: 'x',
  confidence: 'high',
});
const vuln = (...records: Parameters<typeof ghsa>[]): Vulnerability =>
  mergeRecords(records.map((r) => ghsa(...r)))[0]!;

describe('evaluateRange', () => {
  const range = (events: Record<string, string>[]) => ({ type: 'SEMVER' as const, events });

  it('follows introduced / fixed / last_affected semantics', () => {
    const r = range([
      { fixed: '1.5.0' },
      { introduced: '1.0.0' },
      { introduced: '2.0.0' },
      { fixed: '2.1.0' },
    ]);
    expect(evaluateRange(r, '0.9.0', npmVersioning)).toEqual({ affected: false, nextFix: '1.5.0' });
    expect(evaluateRange(r, '1.2.0', npmVersioning)).toEqual({ affected: true, nextFix: '1.5.0' });
    expect(evaluateRange(r, '1.5.0', npmVersioning)).toEqual({ affected: false, nextFix: '2.1.0' });
    expect(evaluateRange(r, '2.0.5', npmVersioning)).toEqual({ affected: true, nextFix: '2.1.0' });
    expect(evaluateRange(r, '3.0.0', npmVersioning)).toEqual({ affected: false });

    const last = range([{ introduced: '0' }, { last_affected: '1.0.0' }, { limit: '9.9.9' }]);
    expect(evaluateRange(last, '1.0.0', npmVersioning).affected).toBe(true);
    expect(evaluateRange(last, '1.0.1', npmVersioning).affected).toBe(false);
    expect(evaluateRange(range([{ introduced: '0' }, {}]), '0', npmVersioning).affected).toBe(true);
  });
});

describe('computeRemediation', () => {
  it('suggests a safe patch within the same major', () => {
    const v = vuln(['GHSA-1', 'express', { fixed: '4.20.0' }]);
    expect(computeRemediation(dep('express', '4.17.1'), v, npmVersioning)).toEqual({
      type: 'safe-patch',
      fixedVersion: '4.20.0',
    });
  });

  it('flags breaking updates', () => {
    const v = vuln(['GHSA-1', 'minimist', { fixed: '1.2.6' }]);
    expect(computeRemediation(dep('minimist', '0.0.8'), v, npmVersioning)).toEqual({
      type: 'breaking-update',
      fixedVersion: '1.2.6',
    });
  });

  it('picks the fix of the range that contains the version, ignoring other branches', () => {
    const record = ghsa('GHSA-1', 'express', { fixed: '4.20.0' });
    record.affected!.push({
      package: { ecosystem: 'npm', name: 'express' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '5.0.0-alpha.1' }, { fixed: '5.0.0' }] }],
    });
    const [v] = mergeRecords([record]);
    expect(computeRemediation(dep('express', '5.0.0-beta.1'), v!, npmVersioning)).toEqual({
      type: 'safe-patch',
      fixedVersion: '5.0.0',
    });
    expect(computeRemediation(dep('express', '4.17.1'), v!, npmVersioning).fixedVersion).toBe(
      '4.20.0',
    );
  });

  it('reports no-fix when an affected range is open-ended', () => {
    expect(computeRemediation(dep('x', '1.0.0'), vuln(['GHSA-1', 'x', {}]), npmVersioning)).toEqual(
      { type: 'no-fix' },
    );
    expect(
      computeRemediation(
        dep('x', '1.0.0'),
        vuln(['GHSA-1', 'x', { last_affected: '1.0.0' }]),
        npmVersioning,
      ),
    ).toEqual({ type: 'no-fix' });
  });

  it('falls back to the nearest fix when listed only by explicit versions', () => {
    const [v] = mergeRecords([
      {
        id: 'OSV-1',
        affected: [
          {
            package: { ecosystem: 'npm', name: 'x' },
            versions: ['1.0.0'],
            ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.0.1' }] }],
          },
          {
            package: { ecosystem: 'npm', name: 'other' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.1' }] }],
          },
          {
            package: { ecosystem: 'npm', name: 'x' },
            ranges: [{ type: 'GIT', events: [{ introduced: 'abc' }] }],
          },
        ],
      },
    ]);
    expect(computeRemediation(dep('x', '1.0.0'), v!, npmVersioning)).toEqual({
      type: 'breaking-update',
      fixedVersion: '2.0.1',
    });
    expect(computeRemediation(dep('x', '3.0.0'), v!, npmVersioning)).toEqual({ type: 'no-fix' });
  });
});
