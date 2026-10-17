'use client';

import { useRouter } from 'next/navigation';
import { ScanPanel } from '@/components/scan/scan-panel';
import { postProjectScan } from '@/lib/api';

/** The anonymous scan panel, saving into the project and opening the stored result. */
export function ProjectScanForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  return (
    <ScanPanel
      signedIn
      callbackURL={`/projects/${projectId}`}
      onSubmit={async (body, signal) => {
        const { scanId } = await postProjectScan(projectId, body, signal);
        router.push(`/projects/${projectId}/scans/${scanId}`);
      }}
    />
  );
}
