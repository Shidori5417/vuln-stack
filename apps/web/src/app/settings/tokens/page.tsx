import { listApiTokens } from '@/server/store';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { TokensManager } from '@/components/tokens-manager';
import { getDb } from '@/server/db';
import { requireUserPage } from '@/server/page-auth';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'API tokens — VulnStack' };

export default async function TokensPage() {
  const user = await requireUserPage();
  const tokens = await listApiTokens(await getDb(), user.id);
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const origin = process.env.BETTER_AUTH_URL?.replace(/\/+$/, '') ?? `${proto}://${host}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API tokens</h1>
        <p className="text-sm text-muted-foreground">
          Tokens let the CLI upload scan results to your projects.
        </p>
      </div>
      <TokensManager
        origin={origin}
        initial={tokens.map((t) => ({
          id: t.id,
          name: t.name,
          prefix: t.prefix,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
          expiresAt: t.expiresAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
