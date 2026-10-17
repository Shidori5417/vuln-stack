import type { Finding } from '@vulnstack/core/meta';
import { SeverityBadge } from '@/components/results/severity';

interface Props {
  added: Finding[];
  fixed: Finding[];
  persisting: Finding[];
}

function Section({ title, hint, findings }: { title: string; hint: string; findings: Finding[] }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-lg font-semibold">
        {title} <span className="text-muted-foreground">({findings.length})</span>
      </h3>
      <p className="text-sm text-muted-foreground">{hint}</p>
      {findings.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing here.
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {findings.map((f) => (
            <li
              key={`${f.fingerprint}|${f.dependency.version}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-sm"
            >
              <SeverityBadge
                severity={f.vulnerability.severity}
                score={f.vulnerability.cvss?.score}
              />
              <span className="font-medium break-all">
                {f.dependency.name}@{f.dependency.version}
              </span>
              <span className="font-mono text-xs">{f.vulnerability.id}</span>
              <span className="text-xs text-muted-foreground sm:ml-auto">
                {f.remediation.fixedVersion
                  ? `fix: ${f.remediation.fixedVersion}`
                  : 'no fix available'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CompareView({ added, fixed, persisting }: Props) {
  return (
    <div className="space-y-8">
      <p className="text-sm" data-testid="compare-summary">
        <strong className="text-sev-high">{added.length} new</strong> ·{' '}
        <strong className="text-ok">{fixed.length} fixed</strong> ·{' '}
        <strong>{persisting.length} still open</strong>
      </p>
      <Section title="New" hint="Present in the newer scan only." findings={added} />
      <Section title="Fixed" hint="Present in the older scan, gone now." findings={fixed} />
      <Section title="Still open" hint="Present in both scans." findings={persisting} />
    </div>
  );
}
