import type { FetchFn } from '@vulnstack/core';
import type { CacheStore, Resolver } from '@vulnstack/core';

export interface Writable {
  write(chunk: string | Uint8Array): unknown;
  isTTY?: boolean;
  columns?: number;
}

/** Everything the CLI touches from the outside world, injectable for tests. */
export interface CliIO {
  stdout: Writable;
  stderr: Writable;
  cwd: string;
  /** Name the CLI was invoked as (vulnstack | vulnscan). */
  prog?: string;
  env: Record<string, string | undefined>;
  fetch?: FetchFn;
  cache?: CacheStore;
  /** DNS resolver for --url SSRF checks (tests inject one; default: nodeResolve). */
  resolve?: Resolver;
}

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;
