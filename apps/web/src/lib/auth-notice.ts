/** Actionable hint shown when GitHub login has no OAuth credentials. */
export function loginNotConfiguredNotice(origin: string): string {
  return `GitHub login is not configured. Create a GitHub OAuth App with callback ${origin}/api/auth/callback/github, set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (plus BETTER_AUTH_SECRET and BETTER_AUTH_URL) in apps/web/.env.local, then restart the server.`;
}

export function authErrorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'GitHub sign-in failed. Please try again.';
}
