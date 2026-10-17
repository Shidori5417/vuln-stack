import { createApiToken, listApiTokens } from '@/server/store';
import { z } from 'zod';
import { handle, json, parse, readJson, requireUser } from '@/server/api';
import { getDb } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullish(),
});

export function GET(request: Request) {
  return handle(async () => {
    const user = await requireUser(request);
    return json({ tokens: await listApiTokens(await getDb(), user.id) });
  });
}

/** The plain token is only ever returned here, once. */
export function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser(request);
    const body = parse(bodySchema, await readJson(request));
    const { token, record } = await createApiToken(await getDb(), user.id, body.name, {
      ...(body.expiresInDays ? { expiresInDays: body.expiresInDays } : {}),
    });
    return json({ token, record }, 201);
  });
}
