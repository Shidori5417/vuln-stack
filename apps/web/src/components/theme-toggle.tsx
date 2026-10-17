'use client';

import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

const ORDER = ['system', 'light', 'dark'] as const;
const ICONS = { system: MonitorIcon, light: SunIcon, dark: MoonIcon };

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // The theme is only known on the client; render a stable icon until then.
  useEffect(() => setMounted(true), []);
  const current = mounted ? ((theme as (typeof ORDER)[number]) ?? 'system') : 'system';
  const Icon = ICONS[current] ?? MonitorIcon;
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]!;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${current}. Switch to ${next}`}
      title={`Theme: ${current}`}
    >
      <Icon />
    </Button>
  );
}
