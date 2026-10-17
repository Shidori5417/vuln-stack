/**
 * SSRF protection for fetching user-supplied URLs.
 *
 * `assertPublicUrl` validates the URL and every address its host resolves to;
 * `safeFetch` re-validates each redirect hop and caps the body size.
 *
 * Residual risk: the check and the actual connection resolve DNS separately, so
 * a hostile DNS server can answer "public" first and "private" later (DNS
 * rebinding). Core cannot pin the connection because it has no HTTP client of
 * its own; DNS pinning is done by the callers: the CLI's `createPinnedFetch`
 * (apps/cli/src/net.ts) and the web app's `apps/web/src/server/pinned-fetch.ts`.
 * Other hosts that fetch untrusted URLs should additionally run in a network
 * without access to internal services, or inject a `fetch` that connects to the
 * address that was validated (e.g. an undici dispatcher with a pinned lookup).
 */
import type { FetchFn } from './context.js';

/** Resolves a hostname to all of its IPv4/IPv6 addresses (see `nodeResolve` in `@vulnstack/core/node`). */
export type Resolver = (hostname: string) => Promise<string[]>;

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export function parseIPv4(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    out.push(n);
  }
  return out;
}

/** Parses an IPv6 address (optionally with an embedded dotted IPv4 tail) into 8 groups. */
export function parseIPv6(input: string): number[] | undefined {
  let text = input;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(':')) return undefined;

  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return undefined;
    const hex = (a: number, b: number) => ((a << 8) | b).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hex(v4[0]!, v4[1]!)}:${hex(v4[2]!, v4[3]!)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parseGroups = (s: string): number[] | undefined => {
    if (s === '') return [];
    const groups: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0]!);
  if (!head) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const rest = parseGroups(halves[1]!);
  if (!rest) return undefined;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return undefined;
  return [...head, ...Array<number>(missing).fill(0), ...rest];
}

function isPrivateIPv4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIPv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const zeros = (...n: number[]) => n.every((x) => x === 0);

  if (zeros(g0, g1, g2, g3, g4, g5)) {
    // ::, ::1 and IPv4-compatible ::a.b.c.d
    if (g6 === 0 && g7 <= 1) return true;
    return isPrivateIPv4(v4(g6, g7));
  }
  if (zeros(g0, g1, g2, g3, g4) && g5 === 0xffff) return isPrivateIPv4(v4(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (zeros(g2, g3, g4, g5)) return isPrivateIPv4(v4(g6, g7));
    if (g2 === 1) return true; // 64:ff9b:1::/48 local-use translation
  }
  if (g0 === 0x2002) return isPrivateIPv4(v4(g1, g2)); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  return false;
}

/** True for private/reserved addresses. Unparseable input counts as blocked. */
export function isBlockedIp(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(bare);
  if (v4) return isPrivateIPv4(v4);
  const v6 = parseIPv6(bare);
  return v6 ? isPrivateIPv6(v6) : true;
}

const BLOCKED_NAME = /(^|\.)(localhost|local|internal)$/;

/**
 * Throws `SsrfError` unless `url` is a public http(s) URL. The WHATWG URL parser
 * normalises decimal/hex/octal IPv4 forms (`http://2130706433`) to dotted
 * decimal, so literals are checked in their canonical form. Hostnames need a
 * `resolve` function; without one they are rejected (fail closed).
 */
export async function assertPublicUrl(
  input: string | URL,
  resolve: Resolver | undefined,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfError(`Invalid URL: ${String(input).slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Only http and https URLs are allowed (got ${url.protocol})`);
  }
  if (url.username || url.password) throw new SsrfError('URLs with credentials are not allowed');
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    throw new SsrfError(`Port ${url.port} is not allowed (only 80 and 443)`);
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') throw new SsrfError('URL has no host');

  if (host.startsWith('[') || parseIPv4(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`Address ${host} is not a public address`);
    return url;
  }
  if (BLOCKED_NAME.test(host) || host === 'metadata') {
    throw new SsrfError(`Host ${host} is not allowed`);
  }
  if (!resolve) throw new SsrfError('A DNS resolver is required to check host names');

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (error) {
    throw new SsrfError(`Could not resolve ${host}: ${(error as Error).message}`);
  }
  if (addresses.length === 0) throw new SsrfError(`Could not resolve ${host}`);
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new SsrfError(`Host ${host} resolves to a non-public address`);
    }
  }
  return url;
}

export interface SafeFetchOptions {
  fetch: FetchFn;
  resolve: Resolver | undefined;
  maxRedirects?: number;
  timeoutMs?: number;
  /** Responses larger than this are rejected while streaming. */
  maxBytes: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** URL after redirects. */
  url: string;
  text: string;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SsrfError(`Response is larger than ${maxBytes} bytes`);
  }
  const decoder = new TextDecoder('utf-8');
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new SsrfError(`Response is larger than ${maxBytes} bytes`);
    return decoder.decode(buf);
  }
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SsrfError(`Response is larger than ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * GET with SSRF checks on the start URL and every redirect hop, no cookies or
 * credentials, a timeout and a streaming body size limit. Redirects are
 * followed manually, so this needs a server-side `fetch` (browsers hide
 * redirect targets). See the module comment for the DNS-rebinding caveat.
 */
export async function safeFetch(input: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const { maxRedirects = 3, timeoutMs = 10_000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let current = input;
    for (let hop = 0; ; hop++) {
      const url = await assertPublicUrl(current, options.resolve);
      const response = await options.fetch(url.href, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: options.headers ?? {},
        signal: controller.signal,
      });
      const location = response.headers.get('location');
      if (REDIRECT_STATUS.has(response.status) && location) {
        await response.body?.cancel().catch(() => undefined);
        if (hop >= maxRedirects) throw new SsrfError(`Too many redirects (limit ${maxRedirects})`);
        try {
          current = new URL(location, url).href;
        } catch {
          throw new SsrfError('Invalid redirect location');
        }
        continue;
      }
      const text = await readLimited(response, options.maxBytes);
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        headers: response.headers,
        url: url.href,
        text,
      };
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
