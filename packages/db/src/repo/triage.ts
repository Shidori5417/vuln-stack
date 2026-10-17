import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { findingTriage } from '../schema.js';
import { getProject } from './projects.js';

export type TriageStatus = (typeof findingTriage.$inferSelect)['status'];
export type Triage = Pick<
  typeof findingTriage.$inferSelect,
  'fingerprint' | 'status' | 'note' | 'updatedAt'
>;

/** Sets (or, with `status: null`, clears) the triage of a finding fingerprint. */
export async function setTriage(
  db: Db,
  ownerId: string,
  projectId: string,
  fingerprint: string,
  status: TriageStatus | null,
  note?: string | null,
): Promise<void> {
  await getProject(db, ownerId, projectId);
  const where = and(
    eq(findingTriage.projectId, projectId),
    eq(findingTriage.fingerprint, fingerprint),
  );
  if (status === null) {
    await db.delete(findingTriage).where(where);
    return;
  }
  const cleanNote = note?.trim().slice(0, 2000) || null;
  const updatedAt = new Date();
  await db
    .insert(findingTriage)
    .values({ projectId, fingerprint, status, note: cleanNote, userId: ownerId, updatedAt })
    .onConflictDoUpdate({
      target: [findingTriage.projectId, findingTriage.fingerprint],
      set: { status, note: cleanNote, userId: ownerId, updatedAt },
    });
}

export async function getTriage(db: Db, projectId: string): Promise<Map<string, Triage>> {
  const rows = await db.query.findingTriage.findMany({
    where: eq(findingTriage.projectId, projectId),
  });
  return new Map(
    rows.map((r) => [
      r.fingerprint,
      { fingerprint: r.fingerprint, status: r.status, note: r.note, updatedAt: r.updatedAt },
    ]),
  );
}
