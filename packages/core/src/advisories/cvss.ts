import { calculateBaseScore } from 'cvss4';
import type { Cvss, CvssSource, Severity } from '../model/types.js';

const VERSION_RE = /^CVSS:(3\.0|3\.1|4\.0)\//;

/** Base score for a CVSS v3.0/3.1/4.0 vector, or undefined if it can't be scored. */
export function parseCvss(vector: string, source: CvssSource): Cvss | undefined {
  const match = VERSION_RE.exec(vector.trim());
  if (!match) return undefined;
  try {
    const score = calculateBaseScore(vector.trim());
    if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;
    return { score, vector: vector.trim(), version: match[1] as Cvss['version'], source };
  } catch {
    return undefined;
  }
}

/** FIRST qualitative rating scale (same for v3 and v4). */
export function severityFromScore(score: number): Severity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'unknown';
}

/** GHSA labels (as found in OSV `database_specific.severity`). */
export function severityFromLabel(label: string | undefined): Severity {
  switch (label?.toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MODERATE':
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    default:
      return 'unknown';
  }
}

/**
 * Picks one vector out of several. v3.x first because that's what NVD and most
 * tooling still report, so scores stay comparable across findings.
 */
export function pickCvss(
  vectors: { type: string; score: string }[],
  source: CvssSource,
): Cvss | undefined {
  const rank = (type: string) => (type === 'CVSS_V3' ? 0 : type === 'CVSS_V4' ? 1 : 2);
  const sorted = [...vectors].sort((a, b) => rank(a.type) - rank(b.type));
  for (const v of sorted) {
    const parsed = parseCvss(v.score, source);
    if (parsed) return parsed;
  }
  return undefined;
}
