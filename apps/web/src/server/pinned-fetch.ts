import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { isBlockedIp, SsrfError, type FetchFn } from '@vulnstack/core';

type DnsLookupAll = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

type LookupCallback = (
  error: Error | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `connect.lookup` for undici that resolves the host itself and refuses to
 * connect when any returned address is private or reserved. The address that was
 * checked is the one that gets connected to, so DNS rebinding between a check
 * and the connection is not possible.
 */
export function createPinnedLookup(resolveAll: DnsLookupAll = dnsLookup as DnsLookupAll) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolveAll(hostname, { all: true }).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(new SsrfError(`Could not resolve ${hostname}`), '');
          return;
        }
        if (addresses.some((a) => isBlockedIp(a.address))) {
          callback(new SsrfError(`Host ${hostname} resolves to a non-public address`), '');
          return;
        }
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), ''),
    );
  };
}

let agent: Agent | undefined;

/** fetch whose every TCP connection goes through `createPinnedLookup`. */
export const pinnedFetch: FetchFn = (url, init) => {
  agent ??= new Agent({ connect: { lookup: createPinnedLookup() } });
  return undiciFetch(url, {
    ...(init as object),
    dispatcher: agent,
  }) as unknown as Promise<Response>;
};
