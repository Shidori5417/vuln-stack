import { listProjects } from '@/server/store';
import { FolderIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { NewProjectForm } from '@/components/projects/new-project-form';
import { SeverityCounts } from '@/components/projects/severity-counts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate } from '@/lib/format';
import { getDb } from '@/server/db';
import { requireUserPage } from '@/server/page-auth';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dashboard — VulnStack' };

export default async function DashboardPage() {
  const user = await requireUserPage();
  const projects = await listProjects(await getDb(), user.id);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>

      {projects.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No projects yet. Create one below, or upload results from the CLI.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="block space-y-2 rounded-xl border bg-card p-4 hover:bg-accent/50"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <FolderIcon className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">{p.name}</span>
                  </span>
                  <Badge variant="outline">{p.sourceType}</Badge>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {p.latestScan
                    ? `Last scan ${formatDate(p.latestScan.startedAt)}`
                    : 'Not scanned yet'}
                </span>
                {p.latestScan &&
                  (p.latestScan.status === 'failed' ? (
                    <Badge variant="critical">failed</Badge>
                  ) : (
                    <SeverityCounts summary={p.latestScan.summary} />
                  ))}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Card>
        <CardHeader>
          <CardTitle>New project</CardTitle>
        </CardHeader>
        <CardContent>
          <NewProjectForm />
        </CardContent>
      </Card>
    </div>
  );
}
