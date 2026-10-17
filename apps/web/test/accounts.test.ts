import { connect, createApiToken, listProjects, schema, type Db } from '@vulnstack/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ScanModule from '@/server/scan';
import { sampleReport } from './sample';

let currentUser: { id: string; name: string; email: string; image: null } | null = null;
vi.mock('@/server/session', () => ({ getCurrentUser: async () => currentUser }));
vi.mock('@/server/scan', async (importOriginal) => {
  const real = await importOriginal<typeof ScanModule>();
  return { ...real, runScan: vi.fn() };
});

const alice = { id: 'u-alice', name: 'Alice', email: 'alice@example.com', image: null } as const;
const bob = { id: 'u-bob', name: 'Bob', email: 'bob@example.com', image: null } as const;

let db: Db;
let close: () => Promise<void>;
let runScan: ReturnType<typeof vi.fn>;
type Routes = Record<string, (r: Request, ...c: never[]) => Promise<Response>>;
const routes: Record<string, Routes> = {};

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

beforeAll(async () => {
  process.env.VULNSTACK_SCANS_PER_MINUTE = '1000';
  process.env.VULNSTACK_MAX_UPLOAD_MB = '1';
  delete process.env.BETTER_AUTH_URL;
  const handle = await connect('pglite:memory');
  await handle.migrate();
  db = handle.db;
  close = handle.close;
  await db.insert(schema.user).values([
    { id: alice.id, name: alice.name, email: alice.email },
    { id: bob.id, name: bob.name, email: bob.email },
  ]);
  const { setDbForTesting } = await import('@/server/db');
  setDbForTesting(db);
  routes.projects = (await import('@/app/api/projects/route')) as unknown as Routes;
  routes.project = (await import('@/app/api/projects/[id]/route')) as unknown as Routes;
  routes.scans = (await import('@/app/api/projects/[id]/scans/route')) as unknown as Routes;
  routes.triage = (await import('@/app/api/projects/[id]/triage/route')) as unknown as Routes;
  routes.tokens = (await import('@/app/api/tokens/route')) as unknown as Routes;
  routes.token = (await import('@/app/api/tokens/[id]/route')) as unknown as Routes;
  routes.upload = (await import('@/app/api/v1/upload/route')) as unknown as Routes;
  runScan = (await import('@/server/scan')).runScan as never;
});

afterAll(async () => close());
beforeEach(() => {
  currentUser = alice;
  runScan.mockReset();
});

const createProject = async (name = 'web-app') => {
  const res = await routes.projects!.POST!(
    call('POST', '/api/projects', { name, sourceType: 'files' }),
  );
  return { res, project: (await res.json()) as { id: string } };
};

describe('projects API', () => {
  it('requires sign-in', async () => {
    currentUser = null;
    expect((await createProject('x')).res.status).toBe(401);
  });

  it('creates, rejects duplicates and bad input, deletes', async () => {
    const { res, project } = await createProject('p-create');
    expect(res.status).toBe(201);
    expect((await createProject('p-create')).res.status).toBe(409);
    const bad = await routes.projects!.POST!(
      call('POST', '/api/projects', { name: '', sourceType: 'x' }),
    );
    expect(bad.status).toBe(400);
    const del = await routes.project!.DELETE!(call('DELETE', '/x'), ctx({ id: project.id }));
    expect(del.status).toBe(204);
    expect(
      (await routes.project!.DELETE!(call('DELETE', '/x'), ctx({ id: project.id }))).status,
    ).toBe(404);
  });

  it("hides other users' projects", async () => {
    const { project } = await createProject('p-private');
    currentUser = bob;
    expect(
      (await routes.project!.DELETE!(call('DELETE', '/x'), ctx({ id: project.id }))).status,
    ).toBe(404);
    const scan = await routes.scans!.POST!(
      call('POST', '/x', { type: 'packages' }),
      ctx({ id: project.id }),
    );
    expect(scan.status).toBe(404);
    expect(await listProjects(db, alice.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: project.id })]),
    );
  });
});

describe('project scans API', () => {
  it('runs a scan and stores it', async () => {
    const { project } = await createProject('p-scan');
    runScan.mockResolvedValue(sampleReport);
    const res = await routes.scans!.POST!(
      call('POST', '/x', { type: 'packages', packages: [] }),
      ctx({ id: project.id }),
    );
    expect(res.status).toBe(201);
    const { scanId } = (await res.json()) as { scanId: string };
    const { getScan } = await import('@vulnstack/db');
    const stored = await getScan(db, alice.id, scanId);
    expect(stored.scan.trigger).toBe('web');
    expect(stored.findings).toHaveLength(sampleReport.findings.length);
  });

  it('records failed scans and reports the error', async () => {
    const { project } = await createProject('p-fail');
    runScan.mockRejectedValue(new Error('osv down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await routes.scans!.POST!(call('POST', '/x', {}), ctx({ id: project.id }));
    spy.mockRestore();
    expect(res.status).toBe(502);
    const { listScans } = await import('@vulnstack/db');
    const scans = await listScans(db, alice.id, project.id);
    expect(scans[0]).toMatchObject({ status: 'failed', trigger: 'web' });
  });

  it('maps input errors to their status', async () => {
    const { project } = await createProject('p-input');
    const { ScanInputError } = await import('@/server/scan');
    runScan.mockRejectedValue(new ScanInputError('nope', 413));
    const res = await routes.scans!.POST!(call('POST', '/x', {}), ctx({ id: project.id }));
    expect(res.status).toBe(413);
  });
});

describe('triage API', () => {
  it('sets and clears triage', async () => {
    const { project } = await createProject('p-triage');
    const put = (body: unknown) =>
      routes.triage!.PUT!(call('PUT', '/x', body), ctx({ id: project.id }));
    expect((await put({ fingerprint: 'fp1', status: 'accepted', note: 'ok' })).status).toBe(200);
    const { getTriage } = await import('@vulnstack/db');
    expect((await getTriage(db, project.id)).get('fp1')).toMatchObject({
      status: 'accepted',
      note: 'ok',
    });
    expect((await put({ fingerprint: 'fp1', status: null })).status).toBe(200);
    expect((await getTriage(db, project.id)).size).toBe(0);
    expect((await put({ fingerprint: 'fp1', status: 'bogus' })).status).toBe(400);
    currentUser = bob;
    expect((await put({ fingerprint: 'fp1', status: 'accepted' })).status).toBe(404);
  });
});

describe('tokens API', () => {
  it('creates, lists and revokes', async () => {
    const created = await routes.tokens!.POST!(
      call('POST', '/api/tokens', { name: 'ci', expiresInDays: 30 }),
    );
    expect(created.status).toBe(201);
    const { token, record } = (await created.json()) as { token: string; record: { id: string } };
    expect(token).toMatch(/^vs_/);

    const listed = await routes.tokens!.GET!(call('GET', '/api/tokens'));
    const body = JSON.stringify(await listed.json());
    expect(body).toContain(record.id);
    expect(body).not.toContain(token);

    expect((await routes.token!.DELETE!(call('DELETE', '/x'), ctx({ id: record.id }))).status).toBe(
      204,
    );
    expect((await routes.token!.DELETE!(call('DELETE', '/x'), ctx({ id: record.id }))).status).toBe(
      404,
    );
    expect(
      (await routes.tokens!.POST!(call('POST', '/api/tokens', { name: 'x', expiresInDays: 7 })))
        .status,
    ).toBe(400);
  });
});

describe('POST /api/v1/upload', () => {
  const upload = (token: string | undefined, body: unknown) =>
    routes.upload!.POST!(
      call('POST', '/api/v1/upload', body, token ? { authorization: `Bearer ${token}` } : {}),
    );

  it('stores a CLI report and returns its url', async () => {
    const { token } = await createApiToken(db, alice.id, 'cli');
    const res = await upload(token, { project: 'cli-proj', report: sampleReport });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { projectId: string; scanId: string; url: string };
    expect(out.url).toBe(`http://localhost/projects/${out.projectId}/scans/${out.scanId}`);
    const { getScan } = await import('@vulnstack/db');
    const stored = await getScan(db, alice.id, out.scanId);
    expect(stored.scan.trigger).toBe('cli');
    expect(stored.project.sourceType).toBe('cli');

    // Same project name reuses the project.
    const again = (await (
      await upload(token, { project: 'cli-proj', report: sampleReport })
    ).json()) as { projectId: string };
    expect(again.projectId).toBe(out.projectId);
  });

  it('rejects bad tokens', async () => {
    expect((await upload('vs_nope', { project: 'p', report: sampleReport })).status).toBe(401);
    expect((await upload(undefined, {})).status).toBe(401);
  });

  it('validates the body', async () => {
    const { token } = await createApiToken(db, alice.id, 'cli2');
    expect((await upload(token, { project: '', report: sampleReport })).status).toBe(400);
    expect(
      (await upload(token, { project: 'p', report: { ...sampleReport, schemaVersion: 2 } })).status,
    ).toBe(400);
    expect((await upload(token, '{not json')).status).toBe(400);
  });

  it('enforces the size limit', async () => {
    const { token } = await createApiToken(db, alice.id, 'cli3');
    const big = { project: 'p', report: sampleReport, pad: 'x'.repeat(1024 * 1024 + 1) };
    expect((await upload(token, big)).status).toBe(413);
  });
});
