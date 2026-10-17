import { describe, expect, it } from 'vitest';
import { githubAccessFrom, hasRepoScope } from '@/lib/github-access';
import {
  mapGitHubError,
  PRIVATE_REPO_MESSAGE,
  PRIVATE_REPO_NO_SCOPE_MESSAGE,
  type ScanInputError,
} from '@/server/scan';
import { isPrivateRepoError } from '@/lib/api';

describe('hasRepoScope', () => {
  it('detects repo in arrays and delimited strings', () => {
    expect(hasRepoScope(['read:user', 'repo'])).toBe(true);
    expect(hasRepoScope('read:user,repo')).toBe(true);
    expect(hasRepoScope('read:user user:email')).toBe(false);
    expect(hasRepoScope(['public_repo', 'repo:status'])).toBe(false);
    expect(hasRepoScope(null)).toBe(false);
    expect(hasRepoScope(undefined)).toBe(false);
  });
});

describe('githubAccessFrom', () => {
  it('maps accounts to a state', () => {
    expect(githubAccessFrom(undefined)).toBe('unlinked');
    expect(githubAccessFrom({ scopes: ['read:user'] })).toBe('not-granted');
    expect(githubAccessFrom({ scopes: ['repo'] })).toBe('granted');
  });
});

describe('mapGitHubError', () => {
  const notFound = new Error('GitHub repository not found or private');
  it('uses the sign-in message without a user token', () => {
    const e = mapGitHubError(notFound) as ScanInputError;
    expect(e.message).toBe(PRIVATE_REPO_MESSAGE);
    expect(e.status).toBe(404);
  });
  it('uses the scope message when a user token exists', () => {
    const e = mapGitHubError(notFound, true) as ScanInputError;
    expect(e.message).toBe(PRIVATE_REPO_NO_SCOPE_MESSAGE);
    expect(e.status).toBe(404);
  });
  it('keeps both messages recognised by the client prompt', () => {
    expect(isPrivateRepoError(PRIVATE_REPO_MESSAGE)).toBe(true);
    expect(isPrivateRepoError(PRIVATE_REPO_NO_SCOPE_MESSAGE)).toBe(true);
  });
});
