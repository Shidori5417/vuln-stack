'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authErrorMessage, loginNotConfiguredNotice } from '@/lib/auth-notice';
import { isGithubAccess, type GithubAccess } from '@/lib/github-access';

interface GithubAccessBoxProps {
  /** Where GitHub sends the user back to after granting; defaults to the current page. */
  callbackURL?: string | undefined;
  /** Whether GitHub OAuth credentials are configured on the server. */
  loginConfigured?: boolean;
  /** Compact form for use next to an error: only the grant button (hidden once granted). */
  inline?: boolean;
}

/** "Private repositories" status plus the button that requests GitHub's `repo` scope. */
export function GithubAccessBox({
  callbackURL,
  loginConfigured = true,
  inline = false,
}: GithubAccessBoxProps) {
  const [access, setAccess] = useState<GithubAccess>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let live = true;
    fetch('/api/github/access')
      .then((r) => r.json() as Promise<{ access?: unknown }>)
      .then((d) => live && isGithubAccess(d.access) && setAccess(d.access))
      .catch(() => {}); // status is advisory; the button still works
    return () => {
      live = false;
    };
  }, []);

  const grant = async () => {
    if (!loginConfigured) {
      setNotice(loginNotConfiguredNotice(window.location.origin));
      return;
    }
    setNotice(undefined);
    try {
      const res = await authClient.linkSocial({
        provider: 'github',
        scopes: ['repo'],
        callbackURL: callbackURL ?? window.location.href,
      });
      if (res?.error) setNotice(res.error.message || 'GitHub sign-in failed.');
    } catch (e) {
      setNotice(authErrorMessage(e));
    }
  };

  const button = (
    <Button type="button" variant="outline" size="sm" onClick={() => void grant()}>
      Grant access to private repositories
    </Button>
  );
  const noticeEl = notice && (
    <p role="status" className="text-sm text-muted-foreground">
      {notice}
    </p>
  );

  if (inline) {
    if (access === 'granted') return null;
    return (
      <div className="mt-3 space-y-2">
        {button}
        {noticeEl}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">Private repositories</p>
      <p
        data-testid="private-access-status"
        className={access === 'granted' ? '' : 'text-muted-foreground'}
      >
        {access === 'granted'
          ? 'Access granted: your GitHub token can read private repositories.'
          : access === undefined
            ? 'Checking access…'
            : 'Access not granted: only public repositories can be scanned.'}
      </p>
      {access !== 'granted' && (
        <>
          <p className="text-xs text-muted-foreground">
            GitHub only offers one scope for this, <code>repo</code>, which includes write
            permission. VulnStack only reads files. It is optional.
          </p>
          {button}
        </>
      )}
      {noticeEl}
    </div>
  );
}
