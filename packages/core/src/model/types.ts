/** Ecosystem identifiers, using the exact names OSV.dev expects. */
export type Ecosystem = 'npm' | 'PyPI' | 'Packagist' | 'Maven' | 'Go' | 'NuGet';

export const ECOSYSTEMS: readonly Ecosystem[] = [
  'npm',
  'PyPI',
  'Packagist',
  'Maven',
  'Go',
  'NuGet',
];

/**
 * How sure we are that `version` is what actually runs.
 * - high: pinned by a lock file or given explicitly by the user
 * - medium: resolved from a manifest range
 * - low: guessed (fingerprinting, unresolvable range)
 */
export type Confidence = 'high' | 'medium' | 'low';

export type DependencyScope = 'prod' | 'dev' | 'optional' | 'peer';

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  isDirect: boolean;
  sourceFile: string;
  confidence: Confidence;
  /** Range as written in a manifest, when the version was derived from it. */
  declaredRange?: string;
  scope?: DependencyScope;
  /** First-party package (e.g. a workspace member): shown in chains, never scanned. */
  internal?: boolean;
}

/** A dependency tree rooted at one (sub)project. Node ids are `name@version`. */
export interface DependencyGraph {
  root: string;
  nodes: Map<string, Dependency>;
  /** parent id → child ids. The root's children use the key `ROOT_ID`. */
  edges: Map<string, Set<string>>;
}

export interface Warning {
  code: string;
  message: string;
  file?: string;
}

/** One scannable unit, e.g. a folder with a lock file inside a monorepo. */
export interface Subproject {
  /** Directory relative to the scan root ('' or '.' for the root itself). */
  path: string;
  ecosystem: Ecosystem;
  graph: DependencyGraph;
  warnings: Warning[];
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'unknown'];

export type CvssSource = 'nvd' | 'ghsa' | 'osv';

export interface Cvss {
  score: number;
  vector: string;
  version: '3.0' | '3.1' | '4.0';
  source: CvssSource;
}

export interface AffectedRangeEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

export interface AffectedRange {
  type: 'SEMVER' | 'ECOSYSTEM' | 'GIT';
  events: AffectedRangeEvent[];
}

export interface AffectedPackage {
  ecosystem: string;
  name: string;
  ranges: AffectedRange[];
  versions: string[];
}

export interface Reference {
  type: string;
  url: string;
}

/** A vulnerability after merging every record that refers to it (CVE, GHSA, …). */
export interface Vulnerability {
  /** Preferred id: CVE first, then GHSA, then anything else. */
  id: string;
  /** Every known id, `id` included. */
  aliases: string[];
  summary: string;
  details?: string;
  severity: Severity;
  cvss?: Cvss;
  published?: string;
  modified?: string;
  references: Reference[];
  affected: AffectedPackage[];
  cwes: string[];
}

export type FixType = 'safe-patch' | 'breaking-update' | 'no-fix';

export interface Remediation {
  type: FixType;
  /** Lowest version that is no longer affected. */
  fixedVersion?: string;
}

export interface Finding {
  /** Stable across scans: `subproject|ecosystem|package|vulnerability id`. */
  fingerprint: string;
  subproject: string;
  dependency: Dependency;
  /** Shortest path from the subproject root, e.g. ['my-app', 'express', 'body-parser']. */
  chain: string[];
  /** Number of distinct paths that pull this dependency in (capped). */
  pathCount: number;
  vulnerability: Vulnerability;
  remediation: Remediation;
}

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

export interface ScanSummary {
  subprojects: number;
  dependencies: number;
  vulnerableDependencies: number;
  findings: number;
  bySeverity: SeverityCounts;
}

/** A technology spotted by passive website fingerprinting (informational unless it is also a dependency). */
export interface DetectedTechnology {
  name: string;
  version?: string;
  /** Asset URL, `headers` or `meta`. */
  source: string;
  confidence: Confidence;
}

export interface ScanResult {
  schemaVersion: 1;
  tool: { name: 'vulnstack'; version: string };
  startedAt: string;
  durationMs: number;
  subprojects: Subproject[];
  findings: Finding[];
  summary: ScanSummary;
  warnings: Warning[];
  /** Technologies fingerprinted from a website scan (see `scanWebsite`). */
  detected?: DetectedTechnology[];
  /** Findings suppressed by ignore rules (see `applyIgnores`). */
  ignored?: {
    finding: Finding;
    rule: { id: string; package?: string; until?: string; reason?: string; source: string };
  }[];
}

/**
 * What reporters need: a ScanResult or the JSON report parsed back, so SARIF and
 * PDF exports also work from a saved `--format json` file or in the browser.
 */
export type ReportInput = Pick<
  ScanResult,
  'tool' | 'startedAt' | 'findings' | 'summary' | 'warnings' | 'ignored'
>;
