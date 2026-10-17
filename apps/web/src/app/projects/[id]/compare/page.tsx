import { compareScans, getProject } from '@/server/store';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CompareView } from '@/components/projects/compare-view';
import { formatDate } from '@/lib/format';
import { getDb } from '@/server/db';
import { orNotFound, requireUserPage } from '@/server/page-auth';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Compare scans — VulnStack' };

export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ base?: string; head?: string }>;
}) {
  const user = await requireUserPage();
  const { id } = await params;
  const { base, head } = await searchParams;
  if (!base || !head) notFound();
  const db = await getDb();
  const project = await orNotFound(getProject(db, user.id, id));
  const result = await orNotFound(compareScans(db, user.id, base, head));
  // compareScans checks both scans share a project, not that it's this one.
  const { base: b, head: h } = result;
  if (b.projectId !== id || h.projectId !== id) notFound();

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/projects/${id}`} className="hover:underline">
            {project.name}
          </Link>{' '}
          / compare
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Scan comparison</h1>
        <p className="text-sm text-muted-foreground">
          {formatDate(b.startedAt)} → {formatDate(h.startedAt)}
        </p>
      </div>
      <CompareView added={result.added} fixed={result.fixed} persisting={result.persisting} />
    </div>
  );
}
