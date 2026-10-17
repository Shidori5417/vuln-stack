import { findOrCreateProject, saveScan, verifyApiToken } from '@/server/store';
import { ECOSYSTEMS, type Ecosystem } from '@vulnstack/core';
import { z } from 'zod';
import {
  config,
  enforceRateLimit,
  handle,
  HttpError,
  json,
  originOf,
  parse,
  readJson,
} from '@/server/api';
import { getDb } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const severity = z.enum(['critical', 'high', 'medium', 'low', 'unknown']);
const counts = z.looseObject({
  critical: z.number(),
  high: z.number(),
  medium: z.number(),
  low: z.number(),
  unknown: z.number(),
});

// Minimal shape check: enough for saveScan to be safe, tolerant of additive CLI fields.
const findingSchema = z.looseObject({
  fingerprint: z.string().min(1).max(500),
  subproject: z.string(),
  dependency: z.looseObject({
    ecosystem: z.enum(ECOSYSTEMS as unknown as [Ecosystem, ...Ecosystem[]]),
    name: z.string(),
    version: z.string(),
    isDirect: z.boolean(),
    sourceFile: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
  }),
  chain: z.array(z.string()),
  pathCount: z.number(),
  vulnerability: z.looseObject({
    id: z.string().min(1),
    aliases: z.array(z.string()),
    summary: z.string(),
    severity,
    references: z.array(z.looseObject({ url: z.string() })),
    cwes: z.array(z.string()),
  }),
  remediation: z.looseObject({
    type: z.enum(['safe-patch', 'breaking-update', 'no-fix']),
    fixedVersion: z.string().optional(),
  }),
});

const bodySchema = z.object({
  project: z.string().trim().min(1).max(100),
  report: z.looseObject({
    schemaVersion: z.literal(1),
    tool: z.looseObject({ name: z.string(), version: z.string() }),
    startedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be a date'),
    durationMs: z.number(),
    findings: z.array(findingSchema),
    summary: z.looseObject({
      subprojects: z.number(),
      dependencies: z.number(),
      vulnerableDependencies: z.number(),
      findings: z.number(),
      bySeverity: counts,
    }),
    subprojects: z.array(
      z.looseObject({
        path: z.string(),
        dependencies: z.array(
          z.looseObject({
            ecosystem: z.string(),
            name: z.string(),
            version: z.string(),
          }),
        ),
      }),
    ),
    warnings: z.array(z.looseObject({ message: z.string() })),
  }),
});

function bearer(request: Request): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
}

export function POST(request: Request) {
  return handle(async () => {
    const token = bearer(request);
    const db = await getDb();
    const userId = token ? await verifyApiToken(db, token) : null;
    if (!userId) throw new HttpError('Invalid or missing API token', 401);
    enforceRateLimit(userId);

    const body = parse(bodySchema, await readJson(request, config.maxUploadBytes));
    const project = await findOrCreateProject(db, userId, body.project, 'cli');
    // The loose schema keeps unknown fields; the shape saveScan reads is validated above.
    const scan = await saveScan(
      db,
      project.id,
      body.report as unknown as Parameters<typeof saveScan>[2],
      'cli',
    );
    const url = `${originOf(request)}/projects/${project.id}/scans/${scan.id}`;
    return json({ projectId: project.id, scanId: scan.id, url }, 201);
  });
}
