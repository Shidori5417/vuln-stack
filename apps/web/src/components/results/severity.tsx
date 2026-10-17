import type { Severity } from '@vulnstack/core/meta';
import { Badge } from '@/components/ui/badge';

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Unknown',
};

export function SeverityBadge({
  severity,
  score,
}: {
  severity: Severity;
  score?: number | undefined;
}) {
  return (
    <Badge variant={severity}>
      {SEVERITY_LABEL[severity]}
      {score !== undefined && <span className="tabular-nums opacity-80">{score.toFixed(1)}</span>}
    </Badge>
  );
}
