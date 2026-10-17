'use client';

import { KeyRoundIcon, LayoutDashboardIcon, LogOutIcon } from 'lucide-react';
import Link from 'next/link';
import { DropdownMenu } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

const item =
  'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent';

export function UserMenu({ name, email }: { name: string; email: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label="Account menu">
          <span className="max-w-32 truncate">{name || email}</span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <DropdownMenu.Label className="truncate px-2 py-1.5 text-xs text-muted-foreground">
            {email}
          </DropdownMenu.Label>
          <DropdownMenu.Item asChild className={item}>
            <Link href="/dashboard">
              <LayoutDashboardIcon className="size-4" /> Dashboard
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild className={item}>
            <Link href="/settings/tokens">
              <KeyRoundIcon className="size-4" /> API tokens
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            className={item}
            onSelect={async () => {
              await authClient.signOut();
              window.location.assign('/');
            }}
          >
            <LogOutIcon className="size-4" /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
