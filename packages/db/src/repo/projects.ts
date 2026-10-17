import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { projects, scans } from '../schema.js';

export type SourceType = (typeof projects.$inferSelect)['sourceType'];
export type Project = typeof projects.$inferSelect;

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export async function createProject(
  db: Db,
  ownerId: string,
  input: { name: string; sourceType: SourceType; sourceRef?: string | null },
): Promise<Project> {
  const name = input.name.trim();
  if (!name) throw new ValidationError('Project name is required');
  const existing = await db.query.projects.findFirst({
    where: and(eq(projects.ownerId, ownerId), eq(projects.name, name)),
  });
  if (existing) throw new ConflictError(`A project named "${name}" already exists`);
  const [row] = await db
    .insert(projects)
    .values({ ownerId, name, sourceType: input.sourceType, sourceRef: input.sourceRef ?? null })
    .returning();
  return row!;
}

/** Projects of a user with their latest scan summary, newest activity first. */
export async function listProjects(db: Db, ownerId: string) {
  const rows = await db.query.projects.findMany({
    where: eq(projects.ownerId, ownerId),
    orderBy: desc(projects.updatedAt),
    with: { scans: { orderBy: desc(scans.startedAt), limit: 1 } },
  });
  return rows.map(({ scans: latest, ...p }) => ({ ...p, latestScan: latest[0] ?? null }));
}

/** Owner-scoped lookup: other users' projects are reported as missing. */
export async function getProject(db: Db, ownerId: string, id: string): Promise<Project> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError('Project');
  const row = await db.query.projects.findFirst({
    where: and(eq(projects.id, id), eq(projects.ownerId, ownerId)),
  });
  if (!row) throw new NotFoundError('Project');
  return row;
}

export async function findOrCreateProject(
  db: Db,
  ownerId: string,
  name: string,
  sourceType: SourceType,
  sourceRef?: string,
) {
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError('Project name is required');
  await db
    .insert(projects)
    .values({ ownerId, name: trimmed, sourceType, sourceRef: sourceRef ?? null })
    .onConflictDoNothing({ target: [projects.ownerId, projects.name] });
  const row = await db.query.projects.findFirst({
    where: and(eq(projects.ownerId, ownerId), eq(projects.name, trimmed)),
  });
  return row!;
}

export async function deleteProject(db: Db, ownerId: string, id: string): Promise<void> {
  await getProject(db, ownerId, id);
  await db.delete(projects).where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)));
}
