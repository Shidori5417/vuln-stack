'use client';

import type { JsonReport } from '@vulnstack/core/report';
import {
  FolderGit2Icon,
  GlobeIcon,
  KeyboardIcon,
  Loader2Icon,
  PackageSearchIcon,
  UploadIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { authErrorMessage, loginNotConfiguredNotice } from '@/lib/auth-notice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  filesBody,
  isValidRepoInput,
  isPrivateRepoError,
  postScan,
  type PackageRow,
  type ScanBody,
} from '@/lib/api';
import type { UploadFile } from '@/lib/files';
import { FileDrop } from './file-drop';
import { ManualEntry } from './manual-entry';

const MAX_UPLOAD = 10 * 1024 * 1024;

interface ScanPanelProps {
  /** Anonymous mode: scan via /api/scan and hand back the report. */
  onResult?: (report: JsonReport) => void;
  /** Replaces the anonymous flow (e.g. saving into a project); throw to show an error. */
  onSubmit?: (body: ScanBody, signal: AbortSignal) => Promise<void>;
  /** Whether the visitor is signed in (decides which private-repo action is offered). */
  signedIn?: boolean;
  /** Whether GitHub OAuth credentials are configured on the server. */
  loginConfigured?: boolean;
}

export function ScanPanel({
  onResult,
  onSubmit,
  signedIn = false,
  loginConfigured = true,
}: ScanPanelProps) {
  const [tab, setTab] = useState('files');
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [rows, setRows] = useState<PackageRow[]>([]);
  const [repoUrl, setRepoUrl] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [repoError, setRepoError] = useState<string>();
  const [authNotice, setAuthNotice] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);

  const validRows = rows.filter((r) => r.name.trim());
  const canScan =
    tab === 'files'
      ? files.length > 0 && files.reduce((n, f) => n + f.size, 0) <= MAX_UPLOAD
      : tab === 'manual'
        ? validRows.length > 0
        : tab === 'repo'
          ? repoUrl.trim() !== ''
          : tab === 'url' && siteUrl.trim() !== '' && consent;

  const githubAuth = async (link: boolean) => {
    if (!loginConfigured) {
      setAuthNotice(loginNotConfiguredNotice(window.location.origin));
      return;
    }
    setAuthNotice(undefined);
    try {
      const callbackURL = window.location.href;
      const res = link
        ? await authClient.linkSocial({ provider: 'github', scopes: ['repo'], callbackURL })
        : await authClient.signIn.social({ provider: 'github', callbackURL });
      if (res?.error) setAuthNotice(res.error.message || 'GitHub sign-in failed.');
    } catch (e) {
      setAuthNotice(authErrorMessage(e));
    }
  };

  const scan = async () => {
    if (tab === 'repo' && !isValidRepoInput(repoUrl)) {
      setRepoError('Enter owner/repo or a https://github.com/owner/repo URL.');
      return;
    }
    setRepoError(undefined);
    setBusy(true);
    setError(undefined);
    controller.current = new AbortController();
    try {
      const body: ScanBody =
        tab === 'files'
          ? filesBody(files)
          : tab === 'repo'
            ? { type: 'repo', url: repoUrl.trim() }
            : tab === 'url'
              ? { type: 'url', url: siteUrl.trim(), consent: true }
              : { type: 'packages', packages: validRows };
      if (onSubmit) await onSubmit(body, controller.current.signal);
      else onResult?.(await postScan(body, controller.current.signal));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="files">
              <UploadIcon /> Files
            </TabsTrigger>
            <TabsTrigger value="manual">
              <KeyboardIcon /> Manual
            </TabsTrigger>
            <TabsTrigger value="repo">
              <FolderGit2Icon /> GitHub repo
            </TabsTrigger>
            <TabsTrigger value="url">
              <GlobeIcon /> Website
            </TabsTrigger>
          </TabsList>
          <TabsContent value="files">
            <FileDrop files={files} onChange={setFiles} maxBytes={MAX_UPLOAD} />
          </TabsContent>
          <TabsContent value="manual">
            <ManualEntry rows={rows} onChange={setRows} />
          </TabsContent>
          <TabsContent value="repo">
            <div className="space-y-3">
              <Label htmlFor="repo-url">GitHub repository</Label>
              <Input
                id="repo-url"
                placeholder="owner/repo"
                value={repoUrl}
                className="h-11 text-base"
                aria-invalid={repoError ? true : undefined}
                onChange={(e) => {
                  setRepoUrl(e.target.value);
                  setRepoError(undefined);
                }}
              />
              {repoError && (
                <p role="alert" className="text-sm text-destructive">
                  {repoError}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Examples: <code>vercel/next.js</code>, <code>https://github.com/owner/repo</code>,{' '}
                <code>https://github.com/owner/repo/tree/main/packages/app</code> (a branch and
                sub-folder). Monorepos are scanned per sub-project. Private repositories need you to
                sign in with GitHub.
              </p>
              {error && isPrivateRepoError(error) && (
                <div className="flex items-center gap-3 text-sm">
                  {signedIn ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void githubAuth(true)}
                    >
                      Grant access to private repositories
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void githubAuth(false)}
                    >
                      Sign in with GitHub
                    </Button>
                  )}
                </div>
              )}
              {authNotice && (
                <p role="status" className="text-sm text-muted-foreground">
                  {authNotice}
                </p>
              )}
            </div>
          </TabsContent>
          <TabsContent value="url">
            <div className="space-y-3">
              <Label htmlFor="site-url">Website address</Label>
              <Input
                id="site-url"
                placeholder="https://example.com"
                value={siteUrl}
                className="h-11 text-base"
                onChange={(e) => setSiteUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The scan is passive: one request for the page plus up to 20 public JavaScript/CSS
                files it references. No crawling beyond that and no active probing. Detected library
                versions are estimates taken from file names and banners.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-current"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                I own this site or have permission to scan it
              </label>
            </div>
          </TabsContent>
        </Tabs>

        {error && (
          <Alert variant="destructive" className="mt-4">
            {error}
          </Alert>
        )}

        <div className="mt-6 flex items-center justify-end gap-2">
          {busy && (
            <Button type="button" variant="ghost" onClick={() => controller.current?.abort()}>
              Cancel
            </Button>
          )}
          <Button type="button" onClick={scan} disabled={!canScan || busy} size="lg">
            {busy ? <Loader2Icon className="animate-spin" /> : <PackageSearchIcon />}
            {busy ? 'Scanning…' : 'Scan for vulnerabilities'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
