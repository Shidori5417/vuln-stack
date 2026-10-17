import type { Log, ReportingDescriptor, Result } from 'sarif';
import { advisoryUrl } from '../advisories/urls.js';
import type { Finding, ReportInput, Severity, Vulnerability } from '../model/types.js';

const LEVEL: Record<Severity, Result.level> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
  unknown: 'warning',
};

/** GitHub's `security-severity` drives its Critical/High/Medium/Low labels. */
const FALLBACK_SCORE: Record<Severity, string> = {
  critical: '9.5',
  high: '8.0',
  medium: '5.5',
  low: '2.0',
  unknown: '5.0',
};

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
export const VULNSTACK_URL = 'https://github.com/Shidori5417/vuln-stack';

function referenceUrl(v: Vulnerability): string {
  return v.references.find((r) => r.type === 'ADVISORY')?.url ?? advisoryUrl(v.id);
}

function rule(v: Vulnerability): ReportingDescriptor {
  const others = v.aliases.filter((a) => a !== v.id);
  const url = referenceUrl(v);
  const markdown = [
    `**${v.id}**${others.length ? ` (${others.join(', ')})` : ''}`,
    '',
    v.summary,
    '',
    v.details ? v.details.slice(0, 4000) : '',
    '',
    `[Advisory](${url})`,
  ].join('\n');
  return {
    id: v.id,
    name: v.id.replace(/[^A-Za-z0-9]/g, ''),
    shortDescription: { text: v.summary || v.id },
    fullDescription: { text: (v.details ?? v.summary ?? v.id).slice(0, 1000) },
    helpUri: url,
    help: { text: `${v.summary}\n${url}`, markdown },
    defaultConfiguration: { level: LEVEL[v.severity] },
    properties: {
      'security-severity': v.cvss ? v.cvss.score.toFixed(1) : FALLBACK_SCORE[v.severity],
      tags: [
        'security',
        'vulnerability',
        'dependency',
        ...v.cwes.map((c) => `external/cwe/${c.toLowerCase()}`),
      ],
      precision: 'very-high',
      ...(v.cvss ? { cvssVector: v.cvss.vector } : {}),
      aliases: v.aliases,
    },
  };
}

function message(f: Finding): string {
  const d = f.dependency;
  const path = f.dependency.isDirect ? 'direct dependency' : `pulled in via ${f.chain.join(' > ')}`;
  const fix = f.remediation.fixedVersion
    ? `Upgrade to ${f.remediation.fixedVersion}${f.remediation.type === 'breaking-update' ? ' (major upgrade)' : ''}.`
    : 'No fixed version is available yet.';
  return `${d.name}@${d.version} (${path}) is affected by ${f.vulnerability.id}: ${f.vulnerability.summary}. ${fix}`;
}

function result(f: Finding, suppression?: { reason?: string; source: string }): Result {
  const uri = f.dependency.sourceFile === 'manual input' ? 'manual-input' : f.dependency.sourceFile;
  const r: Result = {
    ruleId: f.vulnerability.id,
    level: LEVEL[f.vulnerability.severity],
    message: { text: message(f) },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
          region: { startLine: 1 },
        },
        logicalLocations: [
          { name: `${f.dependency.name}@${f.dependency.version}`, kind: 'package' },
        ],
      },
    ],
    partialFingerprints: { vulnstackFinding: f.fingerprint },
    properties: {
      ecosystem: f.dependency.ecosystem,
      package: f.dependency.name,
      version: f.dependency.version,
      direct: f.dependency.isDirect,
      chain: f.chain,
      fixType: f.remediation.type,
      ...(f.remediation.fixedVersion ? { fixedVersion: f.remediation.fixedVersion } : {}),
      confidence: f.dependency.confidence,
    },
  };
  if (suppression) {
    r.suppressions = [
      {
        kind: 'external',
        status: 'accepted',
        justification: suppression.reason ?? `Ignored by ${suppression.source}`,
      },
    ];
  }
  return r;
}

/** SARIF 2.1.0, as accepted by GitHub Code Scanning (`github/codeql-action/upload-sarif`). */
export function toSarif(scan: ReportInput): Log {
  const all = [...scan.findings, ...(scan.ignored ?? []).map((i) => i.finding)];
  const rules = new Map<string, ReportingDescriptor>();
  for (const f of all)
    if (!rules.has(f.vulnerability.id)) rules.set(f.vulnerability.id, rule(f.vulnerability));

  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'VulnStack',
            version: scan.tool.version,
            semanticVersion: scan.tool.version,
            informationUri: VULNSTACK_URL,
            rules: [...rules.values()],
          },
        },
        automationDetails: { id: 'vulnstack/' },
        invocations: [
          {
            executionSuccessful: true,
            startTimeUtc: scan.startedAt,
            toolExecutionNotifications: scan.warnings.map((w) => ({
              level: 'warning' as const,
              message: { text: w.message },
              ...(w.file
                ? { locations: [{ physicalLocation: { artifactLocation: { uri: w.file } } }] }
                : {}),
            })),
          },
        ],
        results: [
          ...scan.findings.map((f) => result(f)),
          ...(scan.ignored ?? []).map((i) => result(i.finding, i.rule)),
        ],
      },
    ],
  };
}

export function formatSarif(scan: ReportInput): string {
  return `${JSON.stringify(toSarif(scan), null, 2)}\n`;
}
