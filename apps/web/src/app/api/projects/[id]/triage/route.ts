import { setTriage } from '@/server/store';
import { z } from 'zod';
import { handle, json, parse, readJson, requireUser } from '@/server/api';
import { getDb } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  fingerprint: z.string().min(1).max(500),
  status: z.enum(['accepted', 'false_positive']).nullable(),
  note: z.string().max(2000).nullish(),
});

export function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser(request);
    const body = parse(bodySchema, await readJson(request));
    await setTriage(
      await getDb(),
      user.id,
      (await params).id,
      body.fingerprint,
      body.status,
      body.note,
    );
    return json({ ok: true });
  });
}
