import type { Metadata, Viewport } from 'next';
import type * as React from 'react';
import { SiteHeader } from '@/components/site-header';
import { ThemeProvider } from '@/components/theme-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'VulnStack — find known vulnerabilities in your stack',
  description:
    'Scan lock files, manifests or a package list for known CVEs and GitHub advisories. Open source.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh">
        <ThemeProvider>
          <SiteHeader />
          <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">{children}</main>
          <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-muted-foreground">
            Data from OSV.dev, the GitHub Advisory Database and NVD. Uploaded files are parsed in
            memory and never stored.
          </footer>
        </ThemeProvider>
      </body>
    </html>
  );
}
