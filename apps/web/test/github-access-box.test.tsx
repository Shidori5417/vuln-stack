// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const linkSocial = vi.fn();
vi.mock('@/lib/auth-client', () => ({
  authClient: { linkSocial: (a: unknown) => linkSocial(a), signIn: { social: vi.fn() } },
}));

import { GithubAccessBox } from '@/components/github-access-box';
import { ProjectScanForm } from '@/components/projects/project-scan-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const mockFetch = (handler: (url: string) => Response | Promise<Response>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => Promise.resolve(handler(url))),
  );
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => linkSocial.mockReset().mockResolvedValue({}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GithubAccessBox', () => {
  it('shows granted status without a button', async () => {
    mockFetch(() => jsonRes({ access: 'granted' }));
    render(<GithubAccessBox />);
    expect(await screen.findByText(/Access granted/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('requests the repo scope and returns to the given callbackURL', async () => {
    mockFetch(() => jsonRes({ access: 'not-granted' }));
    const user = userEvent.setup();
    render(<GithubAccessBox callbackURL="/projects/p1" />);
    expect(await screen.findByText(/Access not granted/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Grant access to private repositories' }));
    expect(linkSocial).toHaveBeenCalledWith({
      provider: 'github',
      scopes: ['repo'],
      callbackURL: '/projects/p1',
    });
  });

  it('shows the auth error', async () => {
    mockFetch(() => jsonRes({ access: 'not-granted' }));
    linkSocial.mockResolvedValue({ error: { message: 'boom' } });
    const user = userEvent.setup();
    render(<GithubAccessBox />);
    await user.click(await screen.findByRole('button', { name: /Grant access/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('boom');
  });
});

describe('ProjectScanForm private repo error', () => {
  it('shows the message with an inline grant button and project callbackURL', async () => {
    const message = 'Repository not found or private. Your GitHub token cannot see it.';
    mockFetch((url) =>
      url.startsWith('/api/github/access')
        ? jsonRes({ access: 'not-granted' })
        : jsonRes({ error: message }, 404),
    );
    const user = userEvent.setup();
    render(<ProjectScanForm projectId="p1" />);
    await user.click(screen.getByRole('tab', { name: /GitHub repo/ }));
    await user.type(screen.getByLabelText('GitHub repository'), 'acme/secret');
    await user.click(screen.getByRole('button', { name: /Scan for vulnerabilities/ }));
    const alert = await screen.findByText(/Repository not found or private/);
    const buttons = await screen.findAllByRole('button', {
      name: 'Grant access to private repositories',
    });
    expect(buttons).toHaveLength(2); // status box + inline in the error
    await user.click(buttons[1]!);
    expect(alert).toBeInTheDocument();
    expect(linkSocial).toHaveBeenCalledWith(
      expect.objectContaining({ callbackURL: '/projects/p1' }),
    );
  });
});
