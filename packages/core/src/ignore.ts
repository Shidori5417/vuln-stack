import type { Finding, ScanResult, Warning } from './model/types.js';

export interface IgnoreRule {
  /** CVE / GHSA / any alias of the vulnerability. */
  id: string;
  /** Optional package name the rule is limited to. */
  package?: string;
  /** ISO date (YYYY-MM-DD) after which the rule stops applying. */
  until?: string;
  reason?: string;
  /** Where the rule came from, e.g. `.vulnstackignore:3` or `--ignore`. */
  source: string;
}

export interface IgnoredFinding {
  finding: Finding;
  rule: IgnoreRule;
}

/**
 * `.vulnstackignore` format, one rule per line:
 *
 *   <id> [<package>] [until=YYYY-MM-DD]  # reason
 *
 * The reason is the comment after `#`; rules without one still apply but warn.
 */
export function parseIgnoreFile(
  content: string,
  file = '.vulnstackignore',
): { rules: IgnoreRule[]; warnings: Warning[] } {
  const rules: IgnoreRule[] = [];
  const warnings: Warning[] = [];
  content.split(/\r?\n/).forEach((raw, index) => {
    const hash = raw.indexOf('#');
    const body = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const reason = hash === -1 ? '' : raw.slice(hash + 1).trim();
    if (!body) return;
    const source = `${file}:${index + 1}`;
    const tokens = body.split(/\s+/);
    const rule: IgnoreRule = { id: tokens[0]!, source };
    for (const token of tokens.slice(1)) {
      const until = /^until=(\d{4}-\d{2}-\d{2})$/.exec(token);
      if (until) rule.until = until[1]!;
      else if (!rule.package) rule.package = token;
      else warnings.push({ code: 'ignore-syntax', message: `Unexpected "${token}"`, file: source });
    }
    if (reason) rule.reason = reason;
    else
      warnings.push({
        code: 'ignore-no-reason',
        message: `Ignoring ${rule.id} without a reason; add "# why" so reviewers know`,
        file: source,
      });
    rules.push(rule);
  });
  return { rules, warnings };
}

/** `--ignore GHSA-1,CVE-2` style values. */
export function ignoreRulesFromIds(ids: string[], source = '--ignore'): IgnoreRule[] {
  return ids
    .flatMap((v) => v.split(','))
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({ id, source }));
}

const today = () => new Date().toISOString().slice(0, 10);

function matches(rule: IgnoreRule, finding: Finding): boolean {
  const ids = finding.vulnerability.aliases.map((a) => a.toUpperCase());
  if (!ids.includes(rule.id.toUpperCase())) return false;
  return !rule.package || rule.package.toLowerCase() === finding.dependency.name.toLowerCase();
}

/**
 * Moves findings matched by a rule into `ignored` and recomputes the summary.
 * Expired and unused rules produce warnings so stale exceptions get cleaned up.
 */
export function applyIgnores(
  result: ScanResult,
  rules: IgnoreRule[],
  now: string = today(),
): ScanResult & { ignored: IgnoredFinding[] } {
  const active: IgnoreRule[] = [];
  const warnings: Warning[] = [...result.warnings];
  for (const rule of rules) {
    if (rule.until && rule.until < now) {
      warnings.push({
        code: 'ignore-expired',
        message: `Ignore rule for ${rule.id} expired on ${rule.until}`,
        file: rule.source,
      });
    } else {
      active.push(rule);
    }
  }

  const used = new Set<IgnoreRule>();
  const findings: Finding[] = [];
  const ignored: IgnoredFinding[] = [];
  for (const finding of result.findings) {
    const rule = active.find((r) => matches(r, finding));
    if (rule) {
      used.add(rule);
      ignored.push({ finding, rule });
    } else {
      findings.push(finding);
    }
  }
  for (const rule of active) {
    if (!used.has(rule))
      warnings.push({
        code: 'ignore-unused',
        message: `Ignore rule for ${rule.id} matched nothing`,
        file: rule.source,
      });
  }

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const f of findings) bySeverity[f.vulnerability.severity]++;
  return {
    ...result,
    findings,
    ignored,
    warnings,
    summary: {
      ...result.summary,
      findings: findings.length,
      vulnerableDependencies: new Set(
        findings.map(
          (f) =>
            `${f.subproject}|${f.dependency.ecosystem}:${f.dependency.name}@${f.dependency.version}`,
        ),
      ).size,
      bySeverity,
    },
  };
}

export const FAIL_LEVELS = ['critical', 'high', 'medium', 'low', 'any'] as const;
export type FailLevel = (typeof FAIL_LEVELS)[number];

/** True when any finding is at or above `level` (`any` also counts unknown severity). */
export function exceedsThreshold(findings: Finding[], level: FailLevel): boolean {
  const order = ['critical', 'high', 'medium', 'low', 'unknown'];
  const limit = level === 'any' ? order.length - 1 : order.indexOf(level);
  return findings.some((f) => order.indexOf(f.vulnerability.severity) <= limit);
}
