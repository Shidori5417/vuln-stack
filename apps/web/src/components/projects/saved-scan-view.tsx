'use client';

import type { JsonReport } from '@vulnstack/core/report';
import { useRouter } from 'next/navigation';
import { ResultsView } from '@/components/results/results-view';
import { requestJson, type TriageMap, type TriageStatus } from '@/lib/api';

export function SavedScanView({
  projectId,
  report,
  triage,
}: {
  projectId: string;
  report: JsonReport;
  triage: TriageMap;
}) {
  const router = useRouter();
  const onTriage = async (fingerprint: string, status: TriageStatus | null, note?: string) => {
    await requestJson('PUT', `/api/projects/${projectId}/triage`, { fingerprint, status, note });
    router.refresh();
  };
  return <ResultsView report={report} triage={triage} onTriage={onTriage} />;
}
