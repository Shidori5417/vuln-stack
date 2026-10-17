import { ShieldCheckIcon } from 'lucide-react';
import { headers } from 'next/headers';
import { SignInButton } from '@/components/auth/sign-in-button';
import { UserMenu } from '@/components/auth/user-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { isLoginConfigured } from '@/server/auth';
import { getCurrentUser } from '@/server/session';

export async function SiteHeader() {
  const user = await getCurrentUser(await headers()).catch(() => null);
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <a href="/" className="flex items-center gap-2 font-semibold">
          <ShieldCheckIcon className="size-5" aria-hidden />
          VulnStack
        </a>
        <nav className="flex items-center gap-1 text-sm">
          <a
            className="hidden rounded-md px-3 py-2 text-muted-foreground hover:text-foreground sm:block"
            href="https://github.com/Shidori5417/vuln-stack"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <ThemeToggle />
          {user ? (
            <UserMenu name={user.name} email={user.email} />
          ) : (
            <SignInButton configured={isLoginConfigured()} />
          )}
        </nav>
      </div>
    </header>
  );
}
