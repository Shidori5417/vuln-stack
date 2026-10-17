// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewProjectForm } from '@/components/projects/new-project-form';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  push.mockReset();
  vi.unstubAllGlobals();
});

const reply = (status: number, body: unknown) =>
  vi.fn(
    async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );

async function submit(fetchMock: ReturnType<typeof vi.fn>, ref = '') {
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  render(<NewProjectForm />);
  await user.type(screen.getByLabelText('Name'), 'my-app');
  if (ref) await user.type(screen.getByLabelText(/Reference/), ref);
  await user.click(screen.getByRole('button', { name: /Create project/ }));
}

describe('NewProjectForm', () => {
  it('shows the real server message for a duplicate name', async () => {
    await submit(reply(409, { error: 'A project named "my-app" already exists' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A project named "my-app" already exists',
    );
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Create project/ })).toBeEnabled();
  });

  it('shows validation and auth messages from the API', async () => {
    await submit(reply(400, { error: 'Invalid request: sourceRef: Too big' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid request: sourceRef');
    cleanup();
    await submit(reply(401, { error: 'Sign in required' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in required');
  });

  it('falls back to the HTTP status when the response is not JSON', async () => {
    await submit(reply(502, '<html>Bad gateway</html>'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (HTTP 502)');
  });

  it('posts the trimmed reference and opens the new project', async () => {
    const fetchMock = reply(201, { id: 'p-1' });
    await submit(fetchMock, '  https://github.com/org/repo  ');
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/projects/p-1'));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'my-app',
      sourceType: 'files',
      sourceRef: 'https://github.com/org/repo',
    });
  });
});
