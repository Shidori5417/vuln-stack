import { desc, eq, sql } from 'drizzle-orm';
import {
  SEVERITY_ORDER,
  type Finding,
  type ScanSummary,
  type Severity,
  type Warning,
} from '@vulnstack/core';
import type { JsonReport } from '@vulnstack/core/report';
import type { Db } from '../client.js';
import { findings, projects, scanDependencies, scans, vulnerabilities } from '../schema.js';
import { getProject, NotFoundError, ValidationError } from './projects.js';

export type Scan = typeof scans.$inferSelect;
export type ScanTrigger = Scan['trigger'];

const CHUNK = 500;

async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

/**
 * Stores a finished scan: summary, dependencies, advisories (upserted) and
 * findings, in one transaction. Raw dependency files are never part of it.
 */
export async function saveScan(
  db: Db,
  projectId: string,
  report: JsonReport,
  trigger: ScanTrigger,
): Promise<Scan> {
  return db.transaction(async (tx) => {
    const finishedAt = new Date();
    const [scan] = await tx
      .insert(scans)
      .values({
        projectId,
        status: 'done',
        trigger,
        startedAt: new Date(report.startedAt),
        finishedAt,
        durationMs: Math.round(report.durationMs),
        summary: report.summary,
        warnings: report.warnings,
        toolVersion: report.tool.version,
      })
      .returning();
    const scanId = scan!.id;

    const deps = report.subprojects.flatMap((s) =>
      s.dependencies
        .filter((d) => !d.internal)
        .map((d) => ({
          scanId,
          subproject: s.path,
          ecosystem: d.ecosystem,
          name: d.name,
          version: d.version,
          isDirect: d.isDirect,
          confidence: d.confidence,
          scope: d.scope ?? null,
          sourceFile: d.sourceFile,
        })),
    );
    await insertChunked(deps, (chunk) => tx.insert(scanDependencies).values(chunk));

    const vulns = new Map(report.findings.map((f) => [f.vulnerability.id, f.vulnerability]));
    await insertChunked([...vulns.values()], (chunk) =>
      tx
        .insert(vulnerabilities)
        .values(
          chunk.map((v) => ({
            id: v.id,
            aliases: v.aliases,
            summary: v.summary,
            details: v.details ?? null,
            severity: v.severity,
            cvss: v.cvss ?? null,
            published: v.published ?? null,
            modified: v.modified ?? null,
            references: v.references,
            cwes: v.cwes,
          })),
        )
        .onConflictDoUpdate({
          target: vulnerabilities.id,
          set: {
            aliases: sql`excluded.aliases`,
            summary: sql`excluded.summary`,
            details: sql`excluded.details`,
            severity: sql`excluded.severity`,
            cvss: sql`excluded.cvss`,
            modified: sql`excluded.modified`,
            references: sql`excluded."references"`,
            cwes: sql`excluded.cwes`,
            updatedAt: finishedAt,
          },
        }),
    );

    await insertChunked(report.findings, (chunk) =>
      tx.insert(findings).values(
        chunk.map((f) => ({
          scanId,
          fingerprint: f.fingerprint,
          subproject: f.subproject,
          ecosystem: f.dependency.ecosystem,
          packageName: f.dependency.name,
          version: f.dependency.version,
          isDirect: f.dependency.isDirect,
          scope: f.dependency.scope ?? null,
          confidence: f.dependency.confidence,
          declaredRange: f.dependency.declaredRange ?? null,
          sourceFile: f.dependency.sourceFile,
          chain: f.chain,
          pathCount: f.pathCount,
          vulnId: f.vulnerability.id,
          severity: f.vulnerability.severity,
          cvssScore: f.vulnerability.cvss?.score ?? null,
          cvss: f.vulnerability.cvss ?? null,
          exploit: f.vulnerability.exploit ?? null,
          fixType: f.remediation.type,
          fixedVersion: f.remediation.fixedVersion ?? null,
        })),
      ),
    );

    await tx.update(projects).set({ updatedAt: finishedAt }).where(eq(projects.id, projectId));
    return scan!;
  });
}

/** Records a scan that could not complete, so history shows the attempt. */
export async function recordFailedScan(
  db: Db,
  projectId: string,
  trigger: ScanTrigger,
  error: string,
): Promise<Scan> {
  const [scan] = await db
    .insert(scans)
    .values({
      projectId,
      status: 'failed',
      trigger,
      finishedAt: new Date(),
      error: error.slice(0, 1000),
    })
    .returning();
  return scan!;
}

export async function listScans(
  db: Db,
  ownerId: string,
  projectId: string,
  limit = 100,
): Promise<Scan[]> {
  await getProject(db, ownerId, projectId);
  return db.query.scans.findMany({
    where: eq(scans.projectId, projectId),
    orderBy: desc(scans.startedAt),
    limit,
  });
}

type FindingRow = typeof findings.$inferSelect & {
  vulnerability: typeof vulnerabilities.$inferSelect;
};

/** Rebuilds the core Finding shape (same as the JSON report) from stored rows. */
export function toFinding(row: FindingRow): Finding {
  const v = row.vulnerability;
  const dependency: Finding['dependency'] = {
    ecosystem: row.ecosystem as Finding['dependency']['ecosystem'],
    name: row.packageName,
    version: row.version,
    isDirect: row.isDirect,
    sourceFile: row.sourceFile,
    confidence: row.confidence as Finding['dependency']['confidence'],
  };
  if (row.scope) dependency.scope = row.scope as NonNullable<Finding['dependency']['scope']>;
  if (row.declaredRange) dependency.declaredRange = row.declaredRange;
  // Severity and score are the scan-time snapshot; text and links are the latest.
  const vulnerability: Finding['vulnerability'] = {
    id: v.id,
    aliases: v.aliases,
    summary: v.summary,
    severity: row.severity as Severity,
    references: v.references,
    affected: [],
    cwes: v.cwes,
  };
  if (v.details) vulnerability.details = v.details;
  if (row.cvss) vulnerability.cvss = row.cvss;
  if (row.exploit) vulnerability.exploit = row.exploit;
  if (v.published) vulnerability.published = v.published;
  if (v.modified) vulnerability.modified = v.modified;
  const type = row.fixType as Finding['remediation']['type'];
  return {
    fingerprint: row.fingerprint,
    subproject: row.subproject,
    dependency,
    chain: row.chain,
    pathCount: row.pathCount,
    vulnerability,
    remediation: row.fixedVersion ? { type, fixedVersion: row.fixedVersion } : { type },
  };
}

export interface StoredScan {
  scan: Scan;
  project: typeof projects.$inferSelect;
  findings: Finding[];
}

const bySeverity = (a: Finding, b: Finding) =>
  SEVERITY_ORDER.indexOf(a.vulnerability.severity) -
    SEVERITY_ORDER.indexOf(b.vulnerability.severity) ||
  (b.vulnerability.cvss?.score ?? 0) - (a.vulnerability.cvss?.score ?? 0) ||
  a.dependency.name.localeCompare(b.dependency.name);

/** Owner-scoped: scans of other users' projects are reported as missing. */
export async function getScan(db: Db, ownerId: string, scanId: string): Promise<StoredScan> {
  if (!/^[0-9a-f-]{36}$/i.test(scanId)) throw new NotFoundError('Scan');
  const row = await db.query.scans.findFirst({
    where: eq(scans.id, scanId),
    with: { project: true },
  });
  if (!row || row.project.ownerId !== ownerId) throw new NotFoundError('Scan');
  const rows = await db.query.findings.findMany({
    where: eq(findings.scanId, scanId),
    with: { vulnerability: true },
  });
  const { project, ...scan } = row;
  return { scan, project, findings: rows.map(toFinding).sort(bySeverity) };
}

const EMPTY_SUMMARY: ScanSummary = {
  subprojects: 0,
  dependencies: 0,
  vulnerableDependencies: 0,
  findings: 0,
  bySeverity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
};

/** A stored scan in the JSON report shape that the UI and reporters understand. */
export function asReport(stored: StoredScan): JsonReport {
  const { scan } = stored;
  return {
    schemaVersion: 1,
    tool: { name: 'vulnstack', version: scan.toolVersion ?? 'unknown' },
    startedAt: scan.startedAt.toISOString(),
    durationMs: scan.durationMs ?? 0,
    subprojects: [],
    findings: stored.findings,
    summary: scan.summary ?? EMPTY_SUMMARY,
    warnings: scan.warnings as Warning[],
  };
}

export interface ScanComparison {
  base: Scan;
  head: Scan;
  /** In head, not in base. */
  added: Finding[];
  /** In base, gone from head. */
  fixed: Finding[];
  persisting: Finding[];
}

/** Compares two scans of the same project by finding fingerprint. */
export async function compareScans(
  db: Db,
  ownerId: string,
  baseId: string,
  headId: string,
): Promise<ScanComparison> {
  const [base, head] = await Promise.all([
    getScan(db, ownerId, baseId),
    getScan(db, ownerId, headId),
  ]);
  if (base.project.id !== head.project.id)
    throw new ValidationError('Scans belong to different projects');
  const baseKeys = new Set(base.findings.map((f) => f.fingerprint));
  const headKeys = new Set(head.findings.map((f) => f.fingerprint));
  return {
    base: base.scan,
    head: head.scan,
    added: head.findings.filter((f) => !baseKeys.has(f.fingerprint)),
    fixed: base.findings.filter((f) => !headKeys.has(f.fingerprint)),
    persisting: head.findings.filter((f) => baseKeys.has(f.fingerprint)),
  };
}
