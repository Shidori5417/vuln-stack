import { getProject, listScans } from '@/server/store';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ComparePicker } from '@/components/projects/compare-picker';
import { DeleteProjectButton } from '@/components/projects/delete-project-button';
import { ProjectScanForm } from '@/components/projects/project-scan-form';
import { SeverityCounts } from '@/components/projects/severity-counts';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/format';
import { getDb } from '@/server/db';
import { orNotFound, requireUserPage } from '@/server/page-auth';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Project — VulnStack' };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserPage();
  const { id } = await params;
  const db = await getDb();
  const [project, scans] = await orNotFound(
    Promise.all([getProject(db, user.id, id), listScans(db, user.id, id)]),
  );
  const done = scans.filter((s) => s.status === 'done');

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            <Link href="/dashboard" className="hover:underline">
              Projects
            </Link>
          </p>
          <h1 className="text-2xl font-semibold tracking-tight break-words">{project.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{project.sourceType}</Badge>
            {project.sourceRef && <span className="break-all">{project.sourceRef}</span>}
          </p>
        </div>
        <DeleteProjectButton projectId={project.id} name={project.name} />
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">New scan</h2>
        <ProjectScanForm projectId={project.id} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Scan history</h2>
        {scans.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            No scans yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Date
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Trigger
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Findings
                  </th>
                  <th scope="col" className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {scans.map((s) => (
                  <tr key={s.id}>
                    <td className="px-3 py-2.5 text-xs">{formatDate(s.startedAt)}</td>
                    <td className="px-3 py-2.5">{s.trigger}</td>
                    <td className="px-3 py-2.5">
                      <Badge
                        variant={
                          s.status === 'done'
                            ? 'ok'
                            : s.status === 'failed'
                              ? 'critical'
                              : 'outline'
                        }
                      >
                        {s.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      {s.status === 'failed' ? (
                        <span className="text-xs text-muted-foreground">{s.error}</span>
                      ) : (
                        <SeverityCounts summary={s.summary} />
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {s.status === 'done' && (
                        <Link
                          href={`/projects/${project.id}/scans/${s.id}`}
                          className="text-sm underline-offset-4 hover:underline"
                        >
                          View
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {done.length >= 2 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Compare scans</h2>
          <ComparePicker
            projectId={project.id}
            scans={done.map((s) => ({
              id: s.id,
              label: `${formatDate(s.startedAt)} (${s.trigger})`,
            }))}
          />
        </section>
      )}
    </div>
  );
}
