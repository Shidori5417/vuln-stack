'use client';

import type { JsonReport } from '@vulnstack/core/report';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { ResultsView } from '@/components/results/results-view';
import { authClient } from '@/lib/auth-client';
import { ScanPanel } from '@/components/scan/scan-panel';

function SignInPrompt() {
  if (!useSearchParams().has('signin')) return null;
  return <Alert>Sign in with GitHub (top right) to view your dashboard.</Alert>;
}

export function HomeView({ loginConfigured }: { loginConfigured: boolean }) {
  const [report, setReport] = useState<JsonReport>();
  const { data: session } = authClient.useSession();

  if (report) return <ResultsView report={report} onReset={() => setReport(undefined)} />;

  return (
    <div className="space-y-8">
      <Suspense>
        <SignInPrompt />
      </Suspense>
      <section className="space-y-3 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Find known vulnerabilities in your stack
        </h1>
        <p className="mx-auto max-w-2xl text-muted-foreground text-balance">
          Drop your lock files or list your packages. VulnStack checks the exact versions against
          OSV.dev and the GitHub Advisory Database — npm, PyPI, Composer, Maven, Go, NuGet,
          RubyGems, Cargo, Hex, Pub and Swift.
        </p>
      </section>
      <ScanPanel
        onResult={setReport}
        signedIn={Boolean(session)}
        loginConfigured={loginConfigured}
      />
      <p className="text-center text-xs text-muted-foreground">
        No account needed. Anonymous scans aren&apos;t saved. Prefer the terminal?{' '}
        <code className="rounded bg-muted px-1.5 py-0.5">npx vulnstack scan</code>
      </p>
    </div>
  );
}
