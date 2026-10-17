'use client';

import * as React from 'react';
import { THEME_STORAGE_KEY } from '@/components/theme-script';

export type Theme = 'system' | 'light' | 'dark';

const MEDIA = '(prefers-color-scheme: dark)';

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function readStored(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // storage unavailable (privacy mode, blocked cookies)
  }
  return 'system';
}

function systemIsDark(): boolean {
  return window.matchMedia(MEDIA).matches;
}

function apply(theme: Theme): 'light' | 'dark' {
  const resolved = theme === 'system' ? (systemIsDark() ? 'dark' : 'light') : theme;
  const root = document.documentElement;
  // Equivalent of next-themes' disableTransitionOnChange.
  const style = document.createElement('style');
  style.appendChild(document.createTextNode('*,*::before,*::after{transition:none!important}'));
  document.head.appendChild(style);
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  // Force a style flush before removing the override.
  void window.getComputedStyle(document.body).opacity;
  setTimeout(() => style.remove(), 1);
  return resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Start from 'system' on server and client so hydration matches; sync after mount.
  const [theme, setThemeState] = React.useState<Theme>('system');
  const [resolvedTheme, setResolved] = React.useState<'light' | 'dark'>('light');

  React.useEffect(() => {
    const stored = readStored();
    setThemeState(stored);
    setResolved(apply(stored));
  }, []);

  React.useEffect(() => {
    if (theme !== 'system') return;
    const mql = window.matchMedia(MEDIA);
    const onChange = () => setResolved(apply('system'));
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return;
      const next = readStored();
      setThemeState(next);
      setResolved(apply(next));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next);
    setResolved(apply(next));
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // ignore: theme still applies for this page view
    }
  }, []);

  const value = React.useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
