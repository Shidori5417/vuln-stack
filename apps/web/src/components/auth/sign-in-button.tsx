'use client';

import { LogInIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

export function SignInButton({ configured }: { configured: boolean }) {
  const [notice, setNotice] = useState<string>();

  const signIn = async () => {
    if (!configured) {
      setNotice('Sign-in is not configured on this server (GitHub OAuth credentials are missing).');
      return;
    }
    await authClient.signIn.social({ provider: 'github', callbackURL: '/dashboard' });
  };

  return (
    <span className="relative inline-flex">
      <Button size="sm" variant="outline" onClick={signIn}>
        <LogInIcon /> Sign in with GitHub
      </Button>
      {notice && (
        <span
          role="status"
          className="absolute top-full right-0 z-50 mt-2 w-64 rounded-md border bg-popover p-3 text-xs text-popover-foreground shadow-md"
        >
          {notice}
        </span>
      )}
    </span>
  );
}
