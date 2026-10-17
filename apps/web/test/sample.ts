import type { JsonReport } from '@vulnstack/core/report';
import type { Finding } from '@vulnstack/core/meta';

function finding(over: {
  id: string;
  name: string;
  severity: Finding['vulnerability']['severity'];
  score?: number;
  direct?: boolean;
  fix?: Finding['remediation'];
  ecosystem?: Finding['dependency']['ecosystem'];
}): Finding {
  const direct = over.direct ?? true;
  return {
    fingerprint: `.|${over.ecosystem ?? 'npm'}|${over.name}|${over.id}`,
    subproject: '',
    dependency: {
      ecosystem: over.ecosystem ?? 'npm',
      name: over.name,
      version: '1.0.0',
      isDirect: direct,
      sourceFile: 'package-lock.json',
      confidence: 'high',
      scope: 'prod',
    },
    chain: direct ? ['app', over.name] : ['app', 'parent', over.name],
    pathCount: direct ? 1 : 2,
    vulnerability: {
      id: over.id,
      aliases: [over.id, `GHSA-${over.id.slice(-4)}`],
      summary: `${over.name} summary`,
      details: 'Some details',
      severity: over.severity,
      ...(over.score !== undefined
        ? {
            cvss: {
              score: over.score,
              vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
              version: '3.1' as const,
              source: 'nvd' as const,
            },
          }
        : {}),
      references: [{ type: 'WEB', url: `https://example.com/${over.id}` }],
      affected: [],
      cwes: ['CWE-79'],
      published: '2024-01-01T00:00:00Z',
    },
    remediation: over.fix ?? { type: 'safe-patch', fixedVersion: '1.0.1' },
  };
}

export const sampleFindings: Finding[] = [
  finding({ id: 'CVE-2021-0001', name: 'minimist', severity: 'critical', score: 9.8 }),
  finding({
    id: 'CVE-2024-0002',
    name: 'body-parser',
    severity: 'high',
    score: 7.5,
    direct: false,
  }),
  finding({
    id: 'CVE-2020-0003',
    name: 'django',
    severity: 'medium',
    score: 5.0,
    ecosystem: 'PyPI',
    fix: { type: 'breaking-update', fixedVersion: '5.0' },
  }),
  finding({ id: 'GHSA-xxxx-0004', name: 'lodash', severity: 'low', fix: { type: 'no-fix' } }),
];

export const sampleReport: JsonReport = {
  schemaVersion: 1,
  tool: { name: 'vulnstack', version: '0.1.0' },
  startedAt: '2026-10-16T12:00:00.000Z',
  durationMs: 1234,
  subprojects: [],
  findings: sampleFindings,
  summary: {
    subprojects: 2,
    dependencies: 40,
    vulnerableDependencies: 4,
    findings: 4,
    bySeverity: { critical: 1, high: 1, medium: 1, low: 1, unknown: 0 },
  },
  warnings: [{ code: 'no-lockfile', message: 'No lock file found', file: 'package.json' }],
};
