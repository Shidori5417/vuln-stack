import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { isBlockedIp, SsrfError, type FetchFn } from '@vulnstack/core';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

/**
 * Node's built-in fetch ignores HTTP(S)_PROXY. When a proxy is configured we
 * route requests through undici's EnvHttpProxyAgent, which also honours NO_PROXY.
 */
export function createFetch(env: Record<string, string | undefined>): FetchFn | undefined {
  if (!PROXY_VARS.some((name) => env[name])) return undefined;
  const dispatcher = new EnvHttpProxyAgent();
  return (input, init) =>
    undiciFetch(input, { ...init, dispatcher } as Parameters<
      typeof undiciFetch
    >[1]) as unknown as Promise<Response>;
}

export type DnsLookupAll = (hostname: string) => Promise<{ address: string; family: number }[]>;

type LookupCallback = (
  error: Error | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * `connect.lookup` for undici: resolves the host, refuses private/reserved
 * addresses and hands the validated address to the socket, so the connection
 * cannot be redirected by a second (rebinding) DNS answer.
 */
export function createPinnedLookup(
  resolveAll: DnsLookupAll = (host) => dnsLookup(host, { all: true }),
) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolveAll(hostname).then(
      (addresses) => {
        const blocked = addresses.find((a) => isBlockedIp(a.address));
        if (addresses.length === 0 || blocked) {
          callback(
            new SsrfError(
              `${hostname} resolves to a private or reserved address (${blocked?.address ?? 'none'})`,
            ),
          );
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  };
}

/**
 * Fetch for scanning untrusted URLs. Direct connections are pinned to validated
 * IPs (DNS-rebinding protection). With HTTP(S)_PROXY set the proxy resolves and
 * connects on its own, so pinning is the proxy's responsibility; core's
 * assertPublicUrl check still runs for every request and redirect hop.
 */
export function createPinnedFetch(
  env: Record<string, string | undefined>,
  lookup: ReturnType<typeof createPinnedLookup> = createPinnedLookup(),
): FetchFn {
  const dispatcher = PROXY_VARS.some((name) => env[name])
    ? new EnvHttpProxyAgent()
    : new Agent({ connect: { lookup } as never });
  return (input, init) =>
    undiciFetch(input, { ...init, dispatcher } as Parameters<
      typeof undiciFetch
    >[1]) as unknown as Promise<Response>;
}
