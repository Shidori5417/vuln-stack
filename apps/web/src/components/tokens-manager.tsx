'use client';

import { CheckIcon, CopyIcon, KeyRoundIcon, Loader2Icon } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { requestJson } from '@/lib/api';
import { formatDate } from '@/lib/format';

export interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export function TokensManager({ initial, origin }: { initial: TokenRow[]; origin: string }) {
  const [tokens, setTokens] = useState(initial);
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('90');
  const [fresh, setFresh] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await requestJson<{ token: string; record: TokenRow }>('POST', '/api/tokens', {
        name,
        expiresInDays: expires === 'never' ? null : Number(expires),
      });
      setFresh(res.token);
      setCopied(false);
      setTokens((t) => [res.record, ...t]);
      setName('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setError(undefined);
    try {
      await requestJson('DELETE', `/api/tokens/${id}`);
      setTokens((t) => t.filter((x) => x.id !== id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copy = async () => {
    if (!fresh) return;
    await navigator.clipboard?.writeText(fresh).catch(() => {});
    setCopied(true);
  };

  return (
    <div className="space-y-8">
      {fresh && (
        <Alert className="flex-col border-ok/40">
          <p className="font-medium">Copy your token now. It will not be shown again.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 rounded bg-muted px-2 py-1.5 text-xs break-all">
              {fresh}
            </code>
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? <CheckIcon /> : <CopyIcon />} {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFresh(undefined)}>
              Dismiss
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use it with the CLI:{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 break-all">
              VULNSTACK_TOKEN=&lt;your token&gt; vulnstack scan --upload --api-url {origin}
            </code>
          </p>
        </Alert>
      )}

      <form onSubmit={create} className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor="token-name">Name</Label>
          <Input
            id="token-name"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="CI pipeline"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="token-expiry">Expires</Label>
          <NativeSelect
            id="token-expiry"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          >
            <option value="30">in 30 days</option>
            <option value="90">in 90 days</option>
            <option value="365">in 1 year</option>
            <option value="never">never</option>
          </NativeSelect>
        </div>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />} Create token
        </Button>
      </form>

      {error && <Alert variant="destructive">{error}</Alert>}

      {tokens.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No active tokens.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                {['Name', 'Token', 'Created', 'Last used', 'Expires', ''].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td className="px-3 py-2.5 font-medium">{t.name}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{t.prefix}…</td>
                  <td className="px-3 py-2.5 text-xs">{formatDate(t.createdAt)}</td>
                  <td className="px-3 py-2.5 text-xs">
                    {t.lastUsedAt ? formatDate(t.lastUsedAt) : 'never'}
                  </td>
                  <td className="px-3 py-2.5 text-xs">
                    {t.expiresAt ? formatDate(t.expiresAt) : 'never'}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Button size="sm" variant="outline" onClick={() => revoke(t.id)}>
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
