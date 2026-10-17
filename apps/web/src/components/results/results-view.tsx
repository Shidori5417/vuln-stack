'use client';

import { SEVERITY_ORDER, type Finding, type Severity } from '@vulnstack/core/meta';
import { formatSarif, renderPdfReport, type JsonReport } from '@vulnstack/core/report';
import { CircleCheckIcon, DownloadIcon, InfoIcon, RotateCcwIcon, SearchIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import type { TriageMap, TriageStatus } from '@/lib/api';
import { download } from '@/lib/download';
import {
  DEFAULT_FILTERS,
  ecosystemsIn,
  filterFindings,
  filtersEqual,
  sortFindings,
  type FindingFilters,
  type SortKey,
} from '@/lib/filter';
import { FindingDetail } from './finding-detail';
import { FindingsTable } from './findings-table';
import { SummaryCards } from './summary-cards';

interface ResultsViewProps {
  report: JsonReport;
  /** Anonymous flow only: shows a "New scan" button. */
  onReset?: () => void;
  /** Triage state by finding fingerprint (saved scans of a project). */
  triage?: TriageMap;
  onTriage?: (
    fingerprint: string,
    status: TriageStatus | null,
    note?: string,
  ) => void | Promise<void>;
}

export function ResultsView({ report, onReset, triage, onTriage }: ResultsViewProps) {
  const [filters, setFilters] = useState<FindingFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'severity',
    desc: false,
  });
  const [selected, setSelected] = useState<Finding>();
  const triagedCount = triage ? Object.keys(triage).length : 0;
  const [hideTriaged, setHideTriaged] = useState(triagedCount > 0);

  const visible = useMemo(() => {
    const found = filterFindings(report.findings, filters);
    const shown = hideTriaged && triage ? found.filter((f) => !triage[f.fingerprint]) : found;
    return sortFindings(shown, sort.key, sort.desc);
  }, [report.findings, filters, sort, hideTriaged, triage]);
  const ecosystems = ecosystemsIn(report.findings);
  const { summary } = report;
  const safe = report.findings.filter((f) => f.remediation.type === 'safe-patch').length;
  const stamp = report.startedAt.slice(0, 10);

  const toggleSeverity = (s: Severity) =>
    setFilters((f) => ({
      ...f,
      severities: f.severities.includes(s)
        ? f.severities.filter((x) => x !== s)
        : SEVERITY_ORDER.filter((x) => x === s || f.severities.includes(x)),
    }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Scan results</h2>
          <p className="text-sm text-muted-foreground">
            {summary.dependencies} dependencies in {summary.subprojects} project
            {summary.subprojects === 1 ? '' : 's'} · {(report.durationMs / 1000).toFixed(1)}s
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              download(
                JSON.stringify(report, null, 2),
                `vulnstack-${stamp}.json`,
                'application/json',
              )
            }
          >
            <DownloadIcon /> JSON
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              download(formatSarif(report), `vulnstack-${stamp}.sarif`, 'application/sarif+json')
            }
          >
            <DownloadIcon /> SARIF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              download(renderPdfReport(report), `vulnstack-${stamp}.pdf`, 'application/pdf')
            }
          >
            <DownloadIcon /> PDF
          </Button>
          {onReset && (
            <Button size="sm" onClick={onReset}>
              <RotateCcwIcon /> New scan
            </Button>
          )}
        </div>
      </div>

      {report.detected && report.detected.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Detected technologies</CardTitle>
            <p className="text-xs text-muted-foreground">
              Versions are estimates based on file names, banners and headers.
            </p>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {report.detected.map((t, i) => (
                <li key={`${t.name}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{t.name}</span>
                  <span className="text-muted-foreground">{t.version ?? 'version unknown'}</span>
                  <span className="truncate text-xs text-muted-foreground" title={t.source}>
                    {t.source}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {summary.findings === 0 ? (
        <Alert className="border-ok/40 text-ok">
          <CircleCheckIcon />
          <span>No known vulnerabilities found in {summary.dependencies} dependencies.</span>
        </Alert>
      ) : (
        <>
          <SummaryCards summary={summary} active={filters.severities} onToggle={toggleSeverity} />
          <p className="text-sm">
            <strong>{summary.findings}</strong> vulnerabilit{summary.findings === 1 ? 'y' : 'ies'}{' '}
            in <strong>{summary.vulnerableDependencies}</strong> of {summary.dependencies}{' '}
            dependencies · <span className="text-ok">{safe} fixable without a major upgrade</span>
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <div className="relative min-w-64 flex-1">
              <SearchIcon
                className="pointer-events-none absolute top-3.5 left-2.5 size-4 text-muted-foreground"
                aria-hidden
              />
              <Input
                aria-label="Search findings"
                placeholder="Search package, CVE, summary…"
                className="h-11 pl-8 text-base"
                value={filters.query}
                onChange={(e) => setFilters({ ...filters, query: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="eco-filter" className="text-xs text-muted-foreground">
                Ecosystem
              </Label>
              <NativeSelect
                id="eco-filter"
                value={filters.ecosystem}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    ecosystem: e.target.value as FindingFilters['ecosystem'],
                  })
                }
              >
                <option value="all">All</option>
                {ecosystems.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rel-filter" className="text-xs text-muted-foreground">
                Dependency
              </Label>
              <NativeSelect
                id="rel-filter"
                value={filters.relation}
                onChange={(e) =>
                  setFilters({ ...filters, relation: e.target.value as FindingFilters['relation'] })
                }
              >
                <option value="all">Direct &amp; transitive</option>
                <option value="direct">Direct only</option>
                <option value="transitive">Transitive only</option>
              </NativeSelect>
            </div>
            <label className="flex h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-current"
                checked={filters.fixableOnly}
                onChange={(e) => setFilters({ ...filters, fixableOnly: e.target.checked })}
              />
              Fixable only
            </label>
            {(triage || onTriage) && (
              <label className="flex h-9 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-current"
                  checked={hideTriaged}
                  onChange={(e) => setHideTriaged(e.target.checked)}
                />
                Hide triaged{triagedCount > 0 ? ` (${triagedCount})` : ''}
              </label>
            )}
            {!filtersEqual(filters, DEFAULT_FILTERS) && (
              <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULT_FILTERS)}>
                Clear
              </Button>
            )}
          </div>

          <p className="text-xs text-muted-foreground" aria-live="polite">
            Showing {visible.length} of {report.findings.length}
          </p>
          {visible.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-10 text-sm text-muted-foreground">
              <p>No findings match your filters</p>
              <Button variant="outline" size="sm" onClick={() => setFilters(DEFAULT_FILTERS)}>
                Clear
              </Button>
            </div>
          )}
          <FindingsTable
            findings={visible}
            sort={sort}
            onSort={(key) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }))}
            onSelect={setSelected}
            {...(triage ? { triage } : {})}
          />
        </>
      )}

      {report.warnings.length > 0 && (
        <details className="rounded-lg border px-4 py-3 text-sm">
          <summary className="flex cursor-pointer items-center gap-2 font-medium">
            <InfoIcon className="size-4" /> Notes ({report.warnings.length})
          </summary>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {report.warnings.map((w, i) => (
              <li key={i}>
                {w.file && <code className="text-xs">{w.file}: </code>}
                {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <FindingDetail
        finding={selected}
        onClose={() => setSelected(undefined)}
        {...(onTriage ? { onTriage } : {})}
        {...(selected && triage?.[selected.fingerprint]
          ? { triage: triage[selected.fingerprint] }
          : {})}
      />
    </div>
  );
}
