import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ScanModule from '@/server/scan';

vi.mock('@/server/scan', async (importOriginal) => {
  const real = await importOriginal<typeof ScanModule>();
  return {
    ...real,
    runScan: vi.fn(async (body: { type?: string }) => {
      if (body.type === 'boom') throw new Error('upstream down');
      if (body.type === 'slow') throw Object.assign(new Error('t'), { name: 'TimeoutError' });
      if (body.type === 'bad') throw new real.ScanInputError('nope');
      return { ok: true };
    }),
  };
});

let POST: (r: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.VULNSTACK_SCANS_PER_MINUTE = '5';
  process.env.VULNSTACK_MAX_UPLOAD_MB = '1';
  process.env.VULNSTACK_TRUST_PROXY = '1';
  ({ POST } = await import('@/app/api/scan/route'));
});

const req = (body: string, ip: string, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/scan', {
    method: 'POST',
    body,
    headers: { 'x-forwarded-for': ip, ...headers },
  });

describe('POST /api/scan', () => {
  it('returns the report and maps errors to status codes', async () => {
    const ok = await POST(req('{"type":"files"}', '1.1.1.1'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.json()).toEqual({ ok: true });
    expect((await POST(req('not json', '1.1.1.2'))).status).toBe(400);
    expect((await POST(req('{"type":"bad"}', '1.1.1.3'))).status).toBe(400);
    expect((await POST(req('{"type":"slow"}', '1.1.1.4'))).status).toBe(504);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = await POST(req('{"type":"boom"}', '1.1.1.5'));
    expect(boom.status).toBe(502);
    expect((await boom.json()).error).toMatch(/Scan failed/);
  });

  it('enforces the upload limit with and without content-length', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    expect((await POST(req(big, '2.2.2.1'))).status).toBe(413);
    expect(
      (await POST(req('{}', '2.2.2.2', { 'content-length': String(5 * 1024 * 1024) }))).status,
    ).toBe(413);
  });

  it('rate limits per client', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await POST(req('{"type":"files"}', '3.3.3.3'))).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const limited = await POST(req('{}', '3.3.3.3'));
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('GET /api/suggest', () => {
  it('validates the ecosystem', async () => {
    const { GET } = await import('@/app/api/suggest/route');
    expect(
      (await GET(new Request('http://localhost/api/suggest?ecosystem=Cargo&q=x'))).status,
    ).toBe(400);
    const res = await GET(new Request('http://localhost/api/suggest?ecosystem=Go&q=gin'));
    expect(await res.json()).toEqual({ suggestions: [] });
  });
});
