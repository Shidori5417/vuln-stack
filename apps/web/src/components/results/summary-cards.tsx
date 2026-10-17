import { SEVERITY_ORDER, type ScanSummary, type Severity } from '@vulnstack/core/meta';
import { cn } from '@/lib/utils';
import { SEVERITY_LABEL } from './severity';

const BAR: Record<Severity, string> = {
  critical: 'bg-sev-critical',
  high: 'bg-sev-high',
  medium: 'bg-sev-medium',
  low: 'bg-sev-low',
  unknown: 'bg-sev-unknown',
};

const TEXT: Record<Severity, string> = {
  critical: 'text-sev-critical',
  high: 'text-sev-high',
  medium: 'text-sev-medium',
  low: 'text-sev-low',
  unknown: 'text-sev-unknown',
};

export function SummaryCards({
  summary,
  active,
  onToggle,
}: {
  summary: ScanSummary;
  active: Severity[];
  onToggle: (s: Severity) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {SEVERITY_ORDER.map((s) => {
        const count = summary.bySeverity[s];
        const pressed = active.includes(s);
        return (
          <button
            key={s}
            type="button"
            aria-pressed={pressed}
            disabled={count === 0}
            onClick={() => onToggle(s)}
            className={cn(
              'relative overflow-hidden rounded-xl border bg-card p-4 text-left shadow-sm transition-colors enabled:hover:bg-accent disabled:opacity-60',
              pressed && 'ring-2 ring-ring',
            )}
          >
            <span className={cn('absolute inset-y-0 left-0 w-1', BAR[s])} aria-hidden />
            <span
              className={cn(
                'block text-3xl font-semibold tabular-nums',
                count > 0 ? TEXT[s] : 'text-muted-foreground',
              )}
            >
              {count}
            </span>
            <span className="text-sm text-muted-foreground">{SEVERITY_LABEL[s]}</span>
          </button>
        );
      })}
    </div>
  );
}
