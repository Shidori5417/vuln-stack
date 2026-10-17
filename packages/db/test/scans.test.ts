import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  asReport,
  compareScans,
  createProject,
  getScan,
  listScans,
  NotFoundError,
  recordFailedScan,
  saveScan,
  schema,
  type DbHandle,
} from '../src/index.js';
import { freshDb, ghsa, insertUser, makeReport, RECORDS } from './helpers.js';

let h: DbHandle;
let alice: string;
let bob: string;
let projectId: string;
beforeAll(async () => {
  h = await freshDb();
  alice = await insertUser(h);
  bob = await insertUser(h);
  projectId = (await createProject(h.db, alice, { name: 'p', sourceType: 'manual' })).id;
});
afterAll(() => h.close());

describe('saveScan / getScan', () => {
  it('stores scan, dependencies, vulnerabilities and findings', async () => {
    const report = await makeReport();
    const scan = await saveScan(h.db, projectId, report, 'web');
    expect(scan.status).toBe('done');
    expect(scan.trigger).toBe('web');
    expect(scan.summary).toEqual(report.summary);

    const deps = await h.db
      .select()
      .from(schema.scanDependencies)
      .where(eq(schema.scanDependencies.scanId, scan.id));
    const expectedDeps = report.subprojects
      .flatMap((s) => s.dependencies)
      .filter((d) => !d.internal);
    expect(deps).toHaveLength(expectedDeps.length);
    expect(deps.map((d) => d.name)).toContain('react');
    expect(deps.every((d) => d.name !== 'manual')).toBe(true);

    const fs = await h.db.select().from(schema.findings).where(eq(schema.findings.scanId, scan.id));
    expect(fs).toHaveLength(report.findings.length);
    expect(report.findings.length).toBe(3);
    const vulns = await h.db.select().from(schema.vulnerabilities);
    expect(vulns.map((v) => v.id)).toEqual(expect.arrayContaining(RECORDS.map((r) => r.id)));
  });

  it('skips internal dependencies', async () => {
    const report = await makeReport('react@18.2.0, left-pad@1.3.0');
    report.subprojects[0]!.dependencies[0]!.internal = true;
    const internalCount = report.subprojects
      .flatMap((s) => s.dependencies)
      .filter((d) => d.internal).length;
    const total = report.subprojects.flatMap((s) => s.dependencies).length;
    expect(internalCount).toBe(1);
    const scan = await saveScan(h.db, projectId, report, 'api');
    const deps = await h.db
      .select()
      .from(schema.scanDependencies)
      .where(eq(schema.scanDependencies.scanId, scan.id));
    expect(deps).toHaveLength(total - internalCount);
  });

  it('upserts advisory data on a second save but keeps the old finding snapshot', async () => {
    const p = await createProject(h.db, alice, { name: 'upsert', sourceType: 'manual' });
    const first = await saveScan(h.db, p.id, await makeReport('express@4.17.1'), 'cli');
    const changed = [
      ...RECORDS.slice(0, 2),
      ghsa(
        'GHSA-cccc-cccc-cccc',
        'express',
        { fixed: '4.18.0' },
        { label: 'LOW', summary: 'rewritten' },
      ),
    ];
    const second = await saveScan(h.db, p.id, await makeReport('express@4.17.1', changed), 'cli');
    const [v] = await h.db
      .select()
      .from(schema.vulnerabilities)
      .where(eq(schema.vulnerabilities.id, 'GHSA-cccc-cccc-cccc'));
    expect(v!.summary).toBe('rewritten');
    expect(v!.severity).toBe('low');

    const a = await getScan(h.db, alice, first.id);
    const b = await getScan(h.db, alice, second.id);
    expect(a.findings[0]!.vulnerability.severity).toBe('high');
    expect(b.findings[0]!.vulnerability.severity).toBe('low');
    expect(a.findings[0]!.vulnerability.summary).toBe('rewritten');
  });

  it('rebuilds findings equal in meaning to the report, sorted by severity', async () => {
    const report = await makeReport();
    const scan = await saveScan(h.db, projectId, report, 'web');
    const stored = await getScan(h.db, alice, scan.id);
    expect(stored.project.id).toBe(projectId);
    expect(stored.findings).toHaveLength(report.findings.length);
    const sev = stored.findings.map((f) => f.vulnerability.severity);
    expect(sev).toEqual(['critical', 'high', 'low']);
    const byFp = new Map(report.findings.map((f) => [f.fingerprint, f]));
    for (const f of stored.findings) {
      const orig = byFp.get(f.fingerprint)!;
      expect(f.dependency).toMatchObject({
        name: orig.dependency.name,
        version: orig.dependency.version,
        ecosystem: orig.dependency.ecosystem,
        isDirect: orig.dependency.isDirect,
        sourceFile: orig.dependency.sourceFile,
      });
      expect(f.chain).toEqual(orig.chain);
      expect(f.pathCount).toBe(orig.pathCount);
      expect(f.remediation).toEqual(orig.remediation);
      expect(f.vulnerability.id).toBe(orig.vulnerability.id);
      expect(f.vulnerability.severity).toBe(orig.vulnerability.severity);
      expect(f.vulnerability.cvss).toEqual(orig.vulnerability.cvss);
      expect(f.vulnerability.cwes).toEqual(orig.vulnerability.cwes);
      expect(f.vulnerability.summary).toBe(orig.vulnerability.summary);
    }
  });

  it('is owner scoped and validates ids', async () => {
    const scan = await saveScan(h.db, projectId, await makeReport('express@4.17.1'), 'web');
    await expect(getScan(h.db, bob, scan.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getScan(h.db, alice, 'bad')).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      getScan(h.db, alice, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('handles large reports in chunks', async () => {
    const names = Array.from({ length: 620 }, (_, i) => `pkg${i}@1.0.0`).join(', ');
    const report = await makeReport(names);
    const scan = await saveScan(h.db, projectId, report, 'cli');
    const deps = await h.db
      .select()
      .from(schema.scanDependencies)
      .where(eq(schema.scanDependencies.scanId, scan.id));
    expect(deps.length).toBeGreaterThanOrEqual(620);
  });
});

describe('asReport', () => {
  it('returns the JsonReport shape', async () => {
    const report = await makeReport();
    const scan = await saveScan(h.db, projectId, report, 'web');
    const out = asReport(await getScan(h.db, alice, scan.id));
    expect(out.schemaVersion).toBe(1);
    expect(out.tool.name).toBe('vulnstack');
    expect(out.tool.version).toBe(report.tool.version);
    expect(out.summary).toEqual(report.summary);
    expect(out.warnings).toEqual(report.warnings);
    expect(out.findings).toHaveLength(3);
    expect(out.subprojects).toEqual([]);
    expect(out.durationMs).toBe(Math.round(report.durationMs));
  });

  it('falls back to defaults for failed scans', async () => {
    const failed = await recordFailedScan(h.db, projectId, 'api', 'boom');
    const out = asReport(await getScan(h.db, alice, failed.id));
    expect(out.tool.version).toBe('unknown');
    expect(out.durationMs).toBe(0);
    expect(out.summary.findings).toBe(0);
    expect(out.findings).toEqual([]);
  });
});

describe('listScans / recordFailedScan', () => {
  it('lists newest first and checks ownership', async () => {
    const p = await createProject(h.db, alice, { name: 'list', sourceType: 'manual' });
    const a = await saveScan(h.db, p.id, await makeReport('react@18.2.0'), 'web');
    await new Promise((r) => setTimeout(r, 5));
    const b = await recordFailedScan(h.db, p.id, 'cli', 'x'.repeat(2000));
    expect(b.status).toBe('failed');
    expect(b.error).toHaveLength(1000);
    expect((await listScans(h.db, alice, p.id)).map((s) => s.id)).toEqual([b.id, a.id]);
    expect(await listScans(h.db, alice, p.id, 1)).toHaveLength(1);
    await expect(listScans(h.db, bob, p.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('compareScans', () => {
  it('splits findings into added / fixed / persisting', async () => {
    const p = await createProject(h.db, alice, { name: 'cmp', sourceType: 'manual' });
    const base = await saveScan(
      h.db,
      p.id,
      await makeReport('lodash@4.17.15, react@18.2.0'),
      'web',
    );
    const head = await saveScan(
      h.db,
      p.id,
      await makeReport('express@4.17.1, lodash@4.17.15'),
      'web',
    );
    const cmp = await compareScans(h.db, alice, base.id, head.id);
    expect(cmp.base.id).toBe(base.id);
    expect(cmp.head.id).toBe(head.id);
    expect(cmp.added.map((f) => f.dependency.name)).toEqual(['express']);
    expect(cmp.fixed).toEqual([]);
    expect(cmp.persisting).toHaveLength(2);

    const rev = await compareScans(h.db, alice, head.id, base.id);
    expect(rev.fixed.map((f) => f.dependency.name)).toEqual(['express']);
    expect(rev.added).toEqual([]);
  });

  it('rejects scans of different projects and foreign owners', async () => {
    const p2 = await createProject(h.db, alice, { name: 'cmp2', sourceType: 'manual' });
    const s1 = await saveScan(h.db, projectId, await makeReport('react@18.2.0'), 'web');
    const s2 = await saveScan(h.db, p2.id, await makeReport('react@18.2.0'), 'web');
    await expect(compareScans(h.db, alice, s1.id, s2.id)).rejects.toThrow('different projects');
    await expect(compareScans(h.db, bob, s1.id, s1.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('exploit data', () => {
  it('round-trips vulnerability.exploit through saveScan/getScan', async () => {
    const report = await makeReport();
    const exploit = {
      kev: true,
      kevDateAdded: '2024-01-02',
      kevDueDate: '2024-01-23',
      kevRansomware: true,
      epss: 0.25,
      epssPercentile: 0.9,
    };
    report.findings[0]!.vulnerability.exploit = exploit;
    const id = report.findings[0]!.vulnerability.id;
    const scan = await saveScan(h.db, projectId, report, 'web');
    const stored = await getScan(h.db, alice, scan.id);
    const byId = new Map(stored.findings.map((f) => [f.vulnerability.id, f]));
    expect(byId.get(id)!.vulnerability.exploit).toEqual(exploit);
    const other = stored.findings.find((f) => f.vulnerability.id !== id)!;
    expect(other.vulnerability.exploit).toBeUndefined();
  });
});
