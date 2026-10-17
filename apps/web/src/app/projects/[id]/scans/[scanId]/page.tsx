import { asReport, getScan, getTriage } from '@/server/store';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SavedScanView } from '@/components/projects/saved-scan-view';
import type { TriageMap } from '@/lib/api';
import { getDb } from '@/server/db';
import { orNotFound, requireUserPage } from '@/server/page-auth';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Scan — VulnStack' };

export default async function ScanPage({
  params,
}: {
  params: Promise<{ id: string; scanId: string }>;
}) {
  const user = await requireUserPage();
  const { id, scanId } = await params;
  const db = await getDb();
  const stored = await orNotFound(getScan(db, user.id, scanId));
  // The URL's project must match the scan's, so links can't mislabel another project.
  if (stored.project.id !== id) notFound();
  const triage: TriageMap = {};
  for (const [fingerprint, t] of await getTriage(db, id)) {
    triage[fingerprint] = { status: t.status, note: t.note };
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        <Link href="/dashboard" className="hover:underline">
          Projects
        </Link>{' '}
        /{' '}
        <Link href={`/projects/${id}`} className="hover:underline">
          {stored.project.name}
        </Link>
      </p>
      <SavedScanView projectId={id} report={asReport(stored)} triage={triage} />
    </div>
  );
}
