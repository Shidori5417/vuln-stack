'use client';

import type { Finding } from '@vulnstack/core/meta';
import { ExternalLinkIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label, Textarea } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import type { TriageMap, TriageStatus } from '@/lib/api';
import { idUrl } from '@/lib/filter';
import { FixCell, TRIAGE_LABEL } from './findings-table';
import { SeverityBadge } from './severity';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/**
 * Advisory details are Markdown. Render headings and paragraphs as text only
 * (no HTML from third parties ends up in the DOM).
 */
function AdvisoryText({ text }: { text: string }) {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      {blocks.map((block, i) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(block);
        if (heading)
          return (
            <h5 key={i} className="pt-1 font-medium text-foreground">
              {heading[1]}
            </h5>
          );
        return (
          <p key={i} className="whitespace-pre-wrap break-words">
            {block.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')}
          </p>
        );
      })}
    </div>
  );
}

const SOURCE_LABEL = { nvd: 'NVD', ghsa: 'GitHub Advisory Database', osv: 'OSV.dev' };

type OnTriage = (
  fingerprint: string,
  status: TriageStatus | null,
  note?: string,
) => void | Promise<void>;

function TriageControls({
  fingerprint,
  current,
  onTriage,
}: {
  fingerprint: string;
  current: TriageMap[string] | undefined;
  onTriage: OnTriage;
}) {
  const [note, setNote] = useState(current?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const apply = async (status: TriageStatus | null) => {
    setBusy(true);
    setError(undefined);
    try {
      await onTriage(fingerprint, status, status ? note : undefined);
      if (!status) setNote('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded-lg border p-3">
      <h4 className="flex items-center gap-2 text-sm font-medium">
        Triage {current && <Badge variant="secondary">{TRIAGE_LABEL[current.status]}</Badge>}
      </h4>
      <Label htmlFor="triage-note" className="text-xs text-muted-foreground">
        Note (optional)
      </Label>
      <Textarea
        id="triage-note"
        rows={2}
        maxLength={2000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why is this acceptable?"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => apply('accepted')}>
          Accepted risk
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => apply('false_positive')}>
          False positive
        </Button>
        {current && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => apply(null)}>
            Clear triage
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}

export function FindingDetail({
  finding,
  onClose,
  triage,
  onTriage,
}: {
  finding: Finding | undefined;
  onClose: () => void;
  triage?: TriageMap[string];
  onTriage?: OnTriage;
}) {
  return (
    <Sheet open={Boolean(finding)} onOpenChange={(open) => !open && onClose()}>
      {finding && (
        <SheetContent>
          <div className="space-y-2">
            <SeverityBadge
              severity={finding.vulnerability.severity}
              score={finding.vulnerability.cvss?.score}
            />
            <SheetTitle>{finding.vulnerability.summary || finding.vulnerability.id}</SheetTitle>
            <SheetDescription>
              {finding.dependency.name}@{finding.dependency.version}
            </SheetDescription>
          </div>

          {onTriage && (
            <TriageControls
              key={finding.fingerprint}
              fingerprint={finding.fingerprint}
              current={triage}
              onTriage={onTriage}
            />
          )}

          <dl className="space-y-2">
            <Row label="Identifiers">
              <span className="flex flex-wrap gap-1.5">
                {finding.vulnerability.aliases.map((id) => (
                  <a
                    key={id}
                    href={idUrl(id)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs underline-offset-4 hover:underline"
                  >
                    {id}
                    <ExternalLinkIcon className="size-3" aria-hidden />
                  </a>
                ))}
              </span>
            </Row>
            {finding.vulnerability.cvss && (
              <Row label="CVSS">
                <span className="font-mono text-xs break-all">
                  {finding.vulnerability.cvss.vector}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Score {finding.vulnerability.cvss.score.toFixed(1)} from{' '}
                  {SOURCE_LABEL[finding.vulnerability.cvss.source]}
                </span>
              </Row>
            )}
            <Row label="Package">
              <span className="font-medium">{finding.dependency.name}</span>{' '}
              <span className="font-mono text-xs">{finding.dependency.version}</span>{' '}
              <Badge variant="outline">{finding.dependency.ecosystem}</Badge>
              {finding.dependency.confidence !== 'high' && (
                <span className="mt-1 block text-xs text-muted-foreground">
                  Estimated version
                  {finding.dependency.declaredRange
                    ? ` (from ${finding.dependency.declaredRange})`
                    : ''}{' '}
                  — add a lock file for exact results.
                </span>
              )}
            </Row>
            <Row label="Dependency path">
              {finding.dependency.isDirect ? (
                'Direct dependency'
              ) : (
                <ol className="flex flex-wrap items-center gap-1 text-xs">
                  {finding.chain.map((name, i) => (
                    <li key={`${name}-${i}`} className="flex items-center gap-1">
                      {i > 0 && <span className="text-muted-foreground">›</span>}
                      <code className={i === finding.chain.length - 1 ? 'font-semibold' : ''}>
                        {name}
                      </code>
                    </li>
                  ))}
                </ol>
              )}
              {finding.pathCount > 1 && (
                <span className="block text-xs text-muted-foreground">
                  and {finding.pathCount - 1} other path(s)
                </span>
              )}
            </Row>
            <Row label="Fix">
              <FixCell finding={finding} />
              {finding.remediation.type === 'breaking-update' && (
                <span className="block text-xs text-muted-foreground">
                  Requires a major version upgrade; check the changelog.
                </span>
              )}
              {!finding.dependency.isDirect && finding.remediation.fixedVersion && (
                <span className="block text-xs text-muted-foreground">
                  Transitive: upgrade the parent ({finding.chain[1]}) or use an override/resolution.
                </span>
              )}
            </Row>
            <Row label="Source file">
              <code className="text-xs">{finding.dependency.sourceFile}</code>
            </Row>
            {finding.vulnerability.published && (
              <Row label="Published">{finding.vulnerability.published.slice(0, 10)}</Row>
            )}
            {finding.vulnerability.cwes.length > 0 && (
              <Row label="Weakness">{finding.vulnerability.cwes.join(', ')}</Row>
            )}
          </dl>

          {finding.vulnerability.details && (
            <section className="space-y-1">
              <h4 className="text-sm font-medium">Details</h4>
              <AdvisoryText text={finding.vulnerability.details.slice(0, 4000)} />
            </section>
          )}

          {finding.vulnerability.references.length > 0 && (
            <section className="space-y-1">
              <h4 className="text-sm font-medium">References</h4>
              <ul className="space-y-1 text-xs">
                {finding.vulnerability.references.slice(0, 15).map((r) => (
                  <li key={r.url} className="truncate">
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline-offset-4 hover:underline"
                    >
                      {r.url}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </SheetContent>
      )}
    </Sheet>
  );
}
