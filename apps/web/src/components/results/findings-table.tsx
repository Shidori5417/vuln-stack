'use client';

import type { Finding } from '@vulnstack/core/meta';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { TriageMap } from '@/lib/api';
import type { SortKey } from '@/lib/filter';
import { cn } from '@/lib/utils';
import { ExploitCell } from './exploit';
import { SeverityBadge } from './severity';

interface Props {
  findings: Finding[];
  sort: { key: SortKey; desc: boolean };
  onSort: (key: SortKey) => void;
  onSelect: (f: Finding) => void;
  triage?: TriageMap;
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: Props['sort'];
  onSort: Props['onSort'];
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <th
      scope="col"
      className={cn('px-3 py-2 font-medium', className)}
      aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {active &&
          (sort.desc ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
      </button>
    </th>
  );
}

export function FixCell({ finding }: { finding: Finding }) {
  const { type, fixedVersion } = finding.remediation;
  if (type === 'no-fix' || !fixedVersion) return <span className="text-sev-high">No fix yet</span>;
  return (
    <span className="flex flex-col">
      <span
        className={cn(
          'font-mono text-xs font-medium',
          type === 'safe-patch' ? 'text-ok' : 'text-sev-medium',
        )}
      >
        {fixedVersion}
      </span>
      <span className="text-xs text-muted-foreground">
        {type === 'safe-patch' ? 'safe patch' : 'breaking update'}
      </span>
    </span>
  );
}

export const TRIAGE_LABEL = {
  accepted: 'Accepted risk',
  false_positive: 'False positive',
} as const;

function TriageBadge({ entry }: { entry: TriageMap[string] | undefined }) {
  if (!entry) return null;
  return <Badge variant="secondary">{TRIAGE_LABEL[entry.status]}</Badge>;
}

export function FindingsTable({ findings, sort, onSort, onSelect, triage }: Props) {
  if (findings.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        No findings match the filters.
      </p>
    );
  }
  return (
    <>
      {/* Phones: one card per finding instead of a wide table. */}
      <ul className="space-y-2 sm:hidden" aria-label="Findings">
        {findings.map((f) => (
          <li key={`${f.fingerprint}|${f.dependency.version}`}>
            <button
              type="button"
              onClick={() => onSelect(f)}
              className="w-full space-y-1.5 rounded-xl border bg-card p-3 text-left text-sm hover:bg-accent/50"
            >
              <span className="flex items-center justify-between gap-2">
                <SeverityBadge
                  severity={f.vulnerability.severity}
                  score={f.vulnerability.cvss?.score}
                />
                <span className="font-mono text-xs">{f.vulnerability.id}</span>
              </span>
              <TriageBadge entry={triage?.[f.fingerprint]} />
              {f.vulnerability.exploit && <ExploitCell vulnerability={f.vulnerability} />}
              <span className="block font-medium break-words">
                {f.dependency.name}{' '}
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {f.dependency.version}
                </span>
              </span>
              <span className="line-clamp-2 block text-muted-foreground">
                {f.vulnerability.summary}
              </span>
              <span className="flex items-end justify-between gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 break-words">
                  {f.dependency.isDirect ? 'direct' : f.chain.slice(1).join(' › ')}
                </span>
                <FixCell finding={f} />
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border sm:block">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <SortHeader
                label="Severity"
                k="severity"
                sort={sort}
                onSort={onSort}
                className="w-28"
              />
              <SortHeader
                label="Package"
                k="package"
                sort={sort}
                onSort={onSort}
                className="min-w-44"
              />
              <SortHeader label="Vulnerability" k="id" sort={sort} onSort={onSort} />
              <SortHeader
                label="Exploit"
                k="exploit"
                sort={sort}
                onSort={onSort}
                className="w-36"
              />
              <th scope="col" className="px-3 py-2 font-medium">
                Fix
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Path
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {findings.map((f) => (
              <tr
                key={`${f.fingerprint}|${f.dependency.version}`}
                tabIndex={0}
                onClick={() => onSelect(f)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSelect(f);
                }}
                className="cursor-pointer align-top hover:bg-accent/50 focus-visible:bg-accent focus-visible:outline-none"
              >
                <td className="px-3 py-2.5">
                  <SeverityBadge
                    severity={f.vulnerability.severity}
                    score={f.vulnerability.cvss?.score}
                  />
                </td>
                <td className="px-3 py-2.5">
                  <div className="font-medium break-words">{f.dependency.name}</div>
                  <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    <span className="font-mono">{f.dependency.version}</span>
                    {f.dependency.scope === 'dev' && <Badge variant="outline">dev</Badge>}
                    {f.dependency.confidence !== 'high' && (
                      <Badge variant="outline">estimated version</Badge>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs font-medium">{f.vulnerability.id}</span>
                    <TriageBadge entry={triage?.[f.fingerprint]} />
                  </div>
                  <div className="line-clamp-2 text-muted-foreground">
                    {f.vulnerability.summary}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <ExploitCell vulnerability={f.vulnerability} />
                </td>
                <td className="px-3 py-2.5">
                  <FixCell finding={f} />
                </td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">
                  {f.dependency.isDirect ? (
                    'direct'
                  ) : (
                    <span className="break-words">{f.chain.slice(1).join(' › ')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
