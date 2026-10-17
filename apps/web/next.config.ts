import path from 'node:path';
import type { NextConfig } from 'next';
import { productionClosureGlobs } from './trace-deps';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const repoRoot = path.join(import.meta.dirname, '../..');
// store.ts loads @vulnstack/db with a native dynamic import, which file tracing
// cannot follow, so list the package and its production dependency tree
// (core, p-limit -> yocto-queue, drizzle-orm, ...) explicitly.
const includes = productionClosureGlobs(path.join(repoRoot, 'packages/db'), import.meta.dirname);

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  output: 'standalone',
  // The DB package locates its SQL migrations relative to its own files, so it
  // must stay a real node module instead of being bundled.
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
  outputFileTracingIncludes: {
    '/**': includes,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
