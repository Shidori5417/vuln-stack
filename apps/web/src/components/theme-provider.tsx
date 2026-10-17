'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type * as React from 'react';

export function ThemeProvider(props: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    />
  );
}
