import type { ScanSummary } from '@vulnstack/core/meta';
import { Badge } from '@/components/ui/badge';

const LEVELS = ['critical', 'high', 'medium', 'low'] as const;

export function SeverityCounts({ summary }: { summary: ScanSummary | null | undefined }) {
  if (!summary) return <span className="text-muted-foreground">—</span>;
  const shown = LEVELS.filter((l) => summary.bySeverity[l] > 0);
  if (shown.length === 0 && summary.bySeverity.unknown === 0) {
    return <Badge variant="ok">clean</Badge>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((l) => (
        <Badge key={l} variant={l} title={l}>
          {summary.bySeverity[l]} {l}
        </Badge>
      ))}
      {summary.bySeverity.unknown > 0 && (
        <Badge variant="unknown">{summary.bySeverity.unknown} unknown</Badge>
      )}
    </span>
  );
}
