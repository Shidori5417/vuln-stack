import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  output: 'standalone',
  // The DB package locates its SQL migrations relative to its own files, so it
  // must stay a real node module instead of being bundled.
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
  outputFileTracingIncludes: {
    '/**': ['./node_modules/@vulnstack/db/**', '../../packages/db/drizzle/**'],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
