import { revokeApiToken } from '@/server/store';
import { handle, requireUser } from '@/server/api';
import { getDb } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser(request);
    await revokeApiToken(await getDb(), user.id, (await params).id);
    return new Response(null, { status: 204 });
  });
}
