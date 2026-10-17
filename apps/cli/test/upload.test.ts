import { describe, expect, it } from 'vitest';
import { MemoryCache, type FetchFn } from '@vulnstack/core';
import { runCli } from '../src/program.js';
import type { CliIO } from '../src/io.js';

const FIXTURES = new URL('../../../fixtures/', import.meta.url).pathname;
const TOKEN = 'vs_secret_token_123';

interface Call {
  url: string;
  init: RequestInit;
}

function setup(upload: (call: Call) => Response | Promise<Response>, env = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetch: FetchFn = async (url, init) => {
    if (url.includes('/api/v1/upload')) {
      const call = { url, init: init ?? {} };
      calls.push(call);
      return upload(call);
    }
    if (url.endsWith('/querybatch')) return new Response(JSON.stringify({ results: [{}] }));
    return new Response('{}', { status: 404 });
  };
  const io: CliIO = {
    stdout: { write: (s: string) => out.push(s), columns: 120 },
    stderr: { write: (s: string) => err.push(s) },
    cwd: FIXTURES,
    env: { VULNSTACK_TOKEN: TOKEN, VULNSTACK_API_URL: 'https://app.test/', ...env },
    fetch,
    cache: new MemoryCache(),
  };
  return { io, calls, out: () => out.join(''), err: () => err.join('') };
}

const ok = () =>
  new Response(JSON.stringify({ projectId: 'p', scanId: 's', url: 'https://app.test/p/s' }), {
    status: 201,
  });
const MANUAL = ['scan', '--manual', 'lodash@4.17.21', '--upload'];

describe('scan --upload', () => {
  it('posts the report with bearer auth and prints the URL', async () => {
    const t = setup(ok);
    const code = await runCli([...MANUAL, '--project', 'acme', '-f', 'json'], t.io);
    expect(code).toBe(0);
    expect(t.calls).toHaveLength(1);
    const { url, init } = t.calls[0]!;
    expect(url).toBe('https://app.test/api/v1/upload');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    });
    const body = JSON.parse(String(init.body)) as { project: string; report: unknown };
    expect(body.project).toBe('acme');
    expect(body.report).toEqual(JSON.parse(t.out()));
    expect(t.err()).toContain('Uploaded to https://app.test/p/s');
    expect(t.out() + t.err()).not.toContain(TOKEN);
  });

  it('fails early without a token', async () => {
    const t = setup(ok, { VULNSTACK_TOKEN: undefined });
    expect(await runCli(MANUAL, t.io)).toBe(2);
    expect(t.err()).toContain('Settings → API tokens');
    expect(t.calls).toHaveLength(0);
  });

  it('fails early without an api url', async () => {
    const t = setup(ok, { VULNSTACK_API_URL: undefined });
    expect(await runCli(MANUAL, t.io)).toBe(2);
    expect(t.err()).toContain('VULNSTACK_API_URL');
  });

  it('uses --api-url over the env and rejects non-http urls', async () => {
    const t = setup(ok);
    await runCli([...MANUAL, '--api-url', 'http://localhost:3000//'], t.io);
    expect(t.calls[0]!.url).toBe('http://localhost:3000/api/v1/upload');
    const bad = setup(ok);
    expect(await runCli([...MANUAL, '--api-url', 'ftp://x'], bad.io)).toBe(2);
    expect(bad.err()).toContain('Invalid --api-url');
  });

  it('reports server errors and exits 2', async () => {
    const t = setup(
      () => new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 }),
    );
    expect(await runCli(MANUAL, t.io)).toBe(2);
    expect(t.err()).toContain('Upload failed: 401 Invalid token');
    expect(t.err()).not.toContain(TOKEN);
  });

  it('reports network errors without leaking the token', async () => {
    const t = setup(() => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(await runCli(MANUAL, t.io)).toBe(2);
    expect(t.err()).toContain('Upload failed: network error: connect ECONNREFUSED');
    expect(t.out() + t.err()).not.toContain(TOKEN);
  });

  it('defaults the project to "manual" or the folder name', async () => {
    const m = setup(ok);
    await runCli(MANUAL, m.io);
    expect(JSON.parse(String(m.calls[0]!.init.body)).project).toBe('manual');
    const f = setup(ok);
    await runCli(['scan', 'npm', '--upload', '--no-resolve'], f.io);
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(String(f.calls[0]!.init.body)).project).toBe('npm');
  });
});
