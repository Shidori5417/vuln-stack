import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isBlockedIp, parseIPv6, safeFetch, SsrfError } from '../src/net/ssrf.js';
import type { FetchFn } from '../src/net/context.js';

const publicResolve = async () => ['93.184.216.34'];

describe('isBlockedIp', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1',
    '64:ff9b::10.0.0.1',
    '64:ff9b:1::1',
    '::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    '[::1]',
    'not-an-ip',
    '1.2.3',
    '999.1.1.1',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '100.63.255.255',
    '100.128.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '169.253.1.1',
    '198.17.0.1',
    '198.20.0.1',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2001:4860:4860::8888',
  ])('allows %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('parseIPv6', () => {
  it('rejects malformed addresses', () => {
    for (const bad of [
      '1',
      ':::',
      '1::2::3',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8:9',
      'g::1',
      '::1.2.3',
      '1:2:3:4:5:6:7::8',
    ]) {
      expect(parseIPv6(bad)).toBeUndefined();
    }
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toHaveLength(8);
  });
});

describe('assertPublicUrl', () => {
  const blocked: [string, RegExp][] = [
    ['ftp://example.com/', /Only http and https/],
    ['file:///etc/passwd', /Only http and https/],
    ['not a url', /Invalid URL/],
    ['http://user:pw@example.com/', /credentials/],
    ['http://example.com:8080/', /Port 8080/],
    ['https://example.com:22/', /Port 22/],
    ['http://localhost/', /not allowed/],
    ['http://LOCALHOST./', /not allowed/],
    ['http://foo.localhost/', /not allowed/],
    ['http://printer.local/', /not allowed/],
    ['http://db.internal/', /not allowed/],
    ['http://metadata.google.internal/computeMetadata/v1/', /not allowed/],
    ['http://metadata/', /not allowed/],
    ['http://127.0.0.1/', /not a public/],
    ['http://2130706433/', /not a public/],
    ['http://0x7f000001/', /not a public/],
    ['http://0177.0.0.1/', /not a public/],
    ['http://127.1/', /not a public/],
    ['http://169.254.169.254/latest/meta-data/', /not a public/],
    ['http://10.0.0.5:80/', /not a public/],
    ['http://[::1]/', /not a public/],
    ['http://[::ffff:127.0.0.1]/', /not a public/],
    ['http://[fe80::1]/', /not a public/],
    ['http://[64:ff9b::7f00:1]/', /not a public/],
  ];
  it.each(blocked)('blocks %s', async (url, message) => {
    await expect(assertPublicUrl(url, publicResolve)).rejects.toThrow(message);
    await expect(assertPublicUrl(url, publicResolve)).rejects.toBeInstanceOf(SsrfError);
  });

  it.each([
    'http://example.com/',
    'https://example.com:443/x?y=1',
    'http://example.com:80/',
    'https://sub.example.co.uk/path',
    'http://93.184.216.34/',
    'https://[2606:4700:4700::1111]/',
  ])('allows %s', async (url) => {
    await expect(assertPublicUrl(url, publicResolve)).resolves.toBeInstanceOf(URL);
  });

  it('checks every resolved address', async () => {
    await expect(
      assertPublicUrl('http://evil.test/', async () => ['8.8.8.8', '10.0.0.1']),
    ).rejects.toThrow(/non-public/);
    await expect(
      assertPublicUrl('http://evil.test/', async () => ['::ffff:169.254.169.254']),
    ).rejects.toThrow(/non-public/);
  });

  it('fails closed without a resolver, on empty or failing resolution', async () => {
    await expect(assertPublicUrl('http://example.com/', undefined)).rejects.toThrow(
      /resolver is required/,
    );
    await expect(assertPublicUrl('http://example.com/', async () => [])).rejects.toThrow(
      /Could not resolve/,
    );
    await expect(
      assertPublicUrl('http://example.com/', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrow(/ENOTFOUND/);
    await expect(assertPublicUrl('http://8.8.8.8/', undefined)).resolves.toBeInstanceOf(URL);
  });
});

describe('safeFetch', () => {
  const opts = (fetch: FetchFn, extra = {}) => ({
    fetch,
    resolve: publicResolve,
    maxBytes: 100,
    ...extra,
  });
  const redirect = (to: string, status = 302) =>
    new Response(null, { status, headers: { location: to } });

  it('returns text and sends a credential-less manual-redirect GET', async () => {
    let init: RequestInit | undefined;
    const res = await safeFetch(
      'http://example.com/a',
      opts(async (_u, i) => {
        init = i;
        return new Response('hello', { status: 200, headers: { 'x-a': 'b' } });
      }),
    );
    expect(res).toMatchObject({
      status: 200,
      ok: true,
      text: 'hello',
      url: 'http://example.com/a',
    });
    expect(res.headers.get('x-a')).toBe('b');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' });
  });

  it('reports non-2xx without throwing', async () => {
    const res = await safeFetch(
      'http://example.com/',
      opts(async () => new Response('no', { status: 404 })),
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it('follows relative redirects', async () => {
    const seen: string[] = [];
    const res = await safeFetch(
      'http://example.com/a',
      opts(async (u) => {
        seen.push(u);
        return u.endsWith('/a') ? redirect('/b', 301) : new Response('done');
      }),
    );
    expect(seen).toEqual(['http://example.com/a', 'http://example.com/b']);
    expect(res.url).toBe('http://example.com/b');
  });

  it('blocks redirects to private addresses and never requests them', async () => {
    const seen: string[] = [];
    const call = safeFetch(
      'http://example.com/a',
      opts(async (u) => {
        seen.push(u);
        return redirect('http://169.254.169.254/latest/meta-data/');
      }),
    );
    await expect(call).rejects.toThrow(/not a public/);
    expect(seen).toEqual(['http://example.com/a']);
  });

  it('blocks redirects whose host resolves privately', async () => {
    const resolve = async (h: string) => (h === 'internal-alias.test' ? ['10.0.0.1'] : ['8.8.8.8']);
    await expect(
      safeFetch('http://example.com/', {
        fetch: async () => redirect('http://internal-alias.test/'),
        resolve,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/non-public/);
  });

  it('enforces the redirect limit', async () => {
    await expect(
      safeFetch(
        'http://example.com/',
        opts(async () => redirect('/loop'), { maxRedirects: 2 }),
      ),
    ).rejects.toThrow(/Too many redirects/);
  });

  it('rejects invalid redirect locations', async () => {
    await expect(
      safeFetch(
        'http://example.com/',
        opts(async () => redirect('http://[')),
      ),
    ).rejects.toThrow(/Invalid redirect/);
  });

  it('enforces the body limit while streaming and via content-length', async () => {
    const stream = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(60));
          c.enqueue(new Uint8Array(60));
          c.close();
        },
      }),
    );
    await expect(
      safeFetch(
        'http://example.com/',
        opts(async () => stream),
      ),
    ).rejects.toThrow(/larger than 100/);
    await expect(
      safeFetch(
        'http://example.com/',
        opts(async () => new Response('x', { headers: { 'content-length': '5000' } })),
      ),
    ).rejects.toThrow(/larger than 100/);
    await expect(
      safeFetch(
        'http://example.com/',
        opts(async () => new Response('y'.repeat(101))),
      ),
    ).rejects.toThrow(/larger than 100/);
  });

  it('falls back to arrayBuffer for bodies without streams', async () => {
    const fake = {
      status: 200,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => new TextEncoder().encode('plain').buffer,
    } as unknown as Response;
    expect(
      (
        await safeFetch(
          'http://example.com/',
          opts(async () => fake),
        )
      ).text,
    ).toBe('plain');
    const huge = { ...fake, arrayBuffer: async () => new ArrayBuffer(500) } as unknown as Response;
    await expect(
      safeFetch(
        'http://example.com/',
        opts(async () => huge),
      ),
    ).rejects.toThrow(/larger/);
  });

  it('aborts on timeout and on caller signal', async () => {
    const hang: FetchFn = (_u, init) =>
      new Promise((_r, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    await expect(safeFetch('http://example.com/', opts(hang, { timeoutMs: 10 }))).rejects.toThrow(
      /timed out/,
    );
    const ctl = new AbortController();
    const pending = safeFetch('http://example.com/', opts(hang, { signal: ctl.signal }));
    ctl.abort(new Error('stop'));
    await expect(pending).rejects.toThrow(/stop/);
    await expect(
      safeFetch('http://example.com/', opts(hang, { signal: ctl.signal })),
    ).rejects.toThrow(/stop/);
  });
});
