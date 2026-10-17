/** Client-safe helpers for the optional GitHub `repo` scope (private repository access). */

export const REPO_SCOPE = 'repo';

/** `signed-out`: no session; `unlinked`: no GitHub account; else whether `repo` was granted. */
export type GithubAccess = 'signed-out' | 'unlinked' | 'granted' | 'not-granted';

/** Scopes come from Better Auth as an array, or a comma/space separated stored string. */
export function hasRepoScope(scopes: readonly string[] | string | null | undefined): boolean {
  const list = typeof scopes === 'string' ? scopes.split(/[\s,]+/) : (scopes ?? []);
  return list.some((s) => s.trim() === REPO_SCOPE);
}

export function githubAccessFrom(
  account: { scopes?: readonly string[] | null } | undefined,
): GithubAccess {
  if (!account) return 'unlinked';
  return hasRepoScope(account.scopes) ? 'granted' : 'not-granted';
}

export const isGithubAccess = (v: unknown): v is GithubAccess =>
  v === 'signed-out' || v === 'unlinked' || v === 'granted' || v === 'not-granted';
