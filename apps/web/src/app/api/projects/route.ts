import { createProject } from '@/server/store';
import { z } from 'zod';
import { handle, json, parse, readJson, requireUser } from '@/server/api';
import { getDb } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  sourceType: z.enum(['files', 'manual', 'repo', 'url']),
  sourceRef: z.string().trim().max(500).optional(),
});

export function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser(request);
    const body = parse(bodySchema, await readJson(request));
    const project = await createProject(await getDb(), user.id, {
      name: body.name,
      sourceType: body.sourceType,
      sourceRef: body.sourceRef || null,
    });
    return json(project, 201);
  });
}
