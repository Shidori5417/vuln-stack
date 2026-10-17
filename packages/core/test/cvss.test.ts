import { describe, expect, it } from 'vitest';
import {
  parseCvss,
  pickCvss,
  severityFromLabel,
  severityFromScore,
} from '../src/advisories/cvss.js';

describe('cvss', () => {
  it('scores v3.0, v3.1 and v4.0 vectors', () => {
    expect(parseCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'osv')).toEqual({
      score: 9.8,
      vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      version: '3.1',
      source: 'osv',
    });
    expect(parseCvss('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N', 'osv')!.score).toBe(8.6);
    expect(
      parseCvss('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N', 'ghsa')!.score,
    ).toBe(9.3);
  });

  it('rejects v2 and malformed vectors', () => {
    expect(parseCvss('AV:N/AC:L/Au:N/C:P/I:P/A:P', 'osv')).toBeUndefined();
    expect(parseCvss('CVSS:3.1/AV:X', 'osv')).toBeUndefined();
  });

  it('prefers v3 over v4 and skips unparseable entries', () => {
    const picked = pickCvss(
      [
        {
          type: 'CVSS_V4',
          score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
        },
        { type: 'CVSS_V3', score: 'CVSS:3.1/broken' },
        { type: 'CVSS_V2', score: 'AV:N/AC:L/Au:N/C:P/I:P/A:P' },
      ],
      'ghsa',
    );
    expect(picked).toMatchObject({ version: '4.0', score: 9.3 });
    expect(pickCvss([], 'osv')).toBeUndefined();
  });

  it('maps scores and labels to severities', () => {
    expect([9, 7, 4, 0.1, 0].map(severityFromScore)).toEqual([
      'critical',
      'high',
      'medium',
      'low',
      'unknown',
    ]);
    expect(
      ['CRITICAL', 'high', 'MODERATE', 'MEDIUM', 'LOW', undefined, 'x'].map(severityFromLabel),
    ).toEqual(['critical', 'high', 'medium', 'medium', 'low', 'unknown', 'unknown']);
  });
});
