import { PgCacheStore } from '@/server/store';
import { Redis } from 'ioredis';
import { z } from 'zod';
import {
  FallbackCache,
  fromIoredis,
  RedisCache,
  ALL_SUPPORTED_PATTERNS,
  ECOSYSTEMS,
  MemoryCache,
  MemoryFileProvider,
  matchesAny,
  scanFiles,
  scanGitHubRepo,
  scanWebsite,
  assertPublicUrl,
  SsrfError,
  type Resolver,
  scanSubprojects,
  toJsonReport,
  createGraph,
  addNode,
  addEdge,
  ROOT_ID,
  type CacheStore,
  type Ecosystem,
  type FetchFn,
  type JsonReport,
  type ScanOptions,
  type Subproject,
} from '@vulnstack/core';
import type { ServerConfig } from './config';
import { nodeResolve } from '@vulnstack/core/node';
import { getDb, hasDatabaseUrl } from './db';
import { pinnedFetch } from './pinned-fetch';

export class ScanInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ScanInputError';
  }
}

const fileSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string(),
});

const packageSchema = z.object({
  ecosystem: z.enum(ECOSYSTEMS as [Ecosystem, ...Ecosystem[]]),
  name: z.string().trim().min(1).max(300),
  version: z.string().trim().max(100),
});

export const scanRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('files'), files: z.array(fileSchema).min(1) }),
  z.object({ type: z.literal('packages'), packages: z.array(packageSchema).min(1).max(1000) }),
  z.object({ type: z.literal('repo'), url: z.string().trim().min(1).max(500) }),
  z.object({
    type: z.literal('url'),
    url: z.string().trim().min(1).max(2000),
    consent: z.literal(true, {
      error: 'You must confirm you own the site or have permission to scan it',
    }),
  }),
]);

export type ScanRequest = z.infer<typeof scanRequestSchema>;

/**
 * Normalises an uploaded path to `a/b/file`, refusing anything that could
 * escape the virtual tree. Only the file name decides whether it's accepted.
 */
export function sanitizePath(path: string): string {
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..' || p.includes('\0'))) {
    throw new ScanInputError(`Invalid file path: ${path}`);
  }
  const name = parts.at(-1)!;
  if (!matchesAny(ALL_SUPPORTED_PATTERNS, name)) {
    throw new ScanInputError(
      `Unsupported file: ${name}. Upload lock files or manifests (package-lock.json, poetry.lock, go.mod, …).`,
    );
  }
  return parts.join('/');
}

function packagesSubprojects(packages: ScanRequest & { type: 'packages' }): Subproject[] {
  const byEco = new Map<Ecosystem, Subproject>();
  for (const p of packages.packages) {
    let sub = byEco.get(p.ecosystem);
    if (!sub) {
      sub = { path: 'manual', ecosystem: p.ecosystem, graph: createGraph('manual'), warnings: [] };
      byEco.set(p.ecosystem, sub);
    }
    const id = addNode(sub.graph, {
      ecosystem: p.ecosystem,
      name: p.name,
      version: p.version,
      isDirect: true,
      sourceFile: 'manual input',
      confidence: p.version ? 'high' : 'medium',
      ...(p.version ? {} : { declaredRange: '*' }),
    });
    addEdge(sub.graph, ROOT_ID, id);
  }
  return [...byEco.values()];
}

export interface ScanDeps {
  fetch?: FetchFn;
  cache?: CacheStore;
  /** Signed-in user's GitHub OAuth token; preferred over the server token for repo scans. */
  githubToken?: string | undefined;
  resolve?: Resolver;
}

export const PRIVATE_REPO_MESSAGE =
  'Repository not found or private. Sign in with GitHub and grant access to private repositories to scan it.';

/** Maps the plain Errors thrown by core's GitHub provider to user-facing input errors. */
export const PRIVATE_REPO_NO_SCOPE_MESSAGE =
  'Repository not found or private. Your GitHub token cannot see it: grant access to private repositories (the repo scope) and retry.';

export function mapGitHubError(e: unknown, hasUserToken = false): unknown {
  if (!(e instanceof Error)) return e;
  if (/^Not a GitHub repository/.test(e.message)) return new ScanInputError(e.message);
  if (/not found or private/i.test(e.message))
    return new ScanInputError(
      hasUserToken ? PRIVATE_REPO_NO_SCOPE_MESSAGE : PRIVATE_REPO_MESSAGE,
      404,
    );
  if (/rejected the access token/.test(e.message)) {
    return new ScanInputError(
      'GitHub rejected your access token. Sign out and sign in again, then retry.',
    );
  }
  if (/rate limit exceeded/.test(e.message)) return new ScanInputError(e.message, 429);
  if (/^GitHub denied access/.test(e.message)) return new ScanInputError(e.message, 403);
  return e;
}

const memoryCache = new MemoryCache(100_000);
let sharedCache: CacheStore | undefined;

/**
 * Advisory cache shared by all scans (only advisory data, never user input):
 * Redis (falling back to Postgres/memory) > Postgres > in-process memory.
 */
async function defaultCache(): Promise<CacheStore> {
  if (sharedCache) return sharedCache;
  const local: CacheStore = hasDatabaseUrl() ? new PgCacheStore(await getDb()) : memoryCache;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return (sharedCache = local);
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  // Without a listener ioredis logs every reconnect failure; FallbackCache handles them.
  redis.on('error', () => {});
  return (sharedCache = new FallbackCache(new RedisCache(fromIoredis(redis)), local, () =>
    console.warn('Redis cache unavailable; falling back to the local cache'),
  ));
}

export async function runScan(
  body: unknown,
  config: ServerConfig,
  deps: ScanDeps = {},
): Promise<JsonReport> {
  const parsed = scanRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ScanInputError(
      `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`,
    );
  }
  const request = parsed.data;

  const options: ScanOptions = {
    cache: deps.cache ?? (await defaultCache()),
    signal: AbortSignal.timeout(config.scanTimeoutMs),
    kev: config.kev,
    epss: config.epss,
  };
  if (deps.fetch) options.fetch = deps.fetch;
  if (config.githubToken) options.ghsa = { token: config.githubToken };
  // A short NVD budget keeps the request snappy; scores fill in over time via the cache.
  if (config.nvdApiKey) options.nvd = { apiKey: config.nvdApiKey, maxWaitMs: 3000 };

  if (request.type === 'repo') {
    const token = deps.githubToken ?? config.githubToken;
    try {
      return toJsonReport(
        await scanGitHubRepo(request.url, {
          ...options,
          maxFiles: config.maxFiles,
          ...(token ? { token } : {}),
        }),
      );
    } catch (e) {
      throw mapGitHubError(e, Boolean(deps.githubToken));
    }
  }

  if (request.type === 'url') {
    const resolve = deps.resolve ?? nodeResolve;
    try {
      await assertPublicUrl(request.url, resolve);
      return toJsonReport(
        await scanWebsite(request.url, {
          ...options,
          fetch: deps.fetch ?? pinnedFetch,
          resolve,
          maxAssets: 20,
        }),
      );
    } catch (e) {
      if (e instanceof SsrfError) {
        throw new ScanInputError(`This address can't be scanned: ${e.message}`);
      }
      throw e;
    }
  }

  if (request.type === 'packages') {
    return toJsonReport(await scanSubprojects(packagesSubprojects(request), options));
  }

  if (request.files.length > config.maxFiles) {
    throw new ScanInputError(
      `Too many files (${request.files.length}); the limit is ${config.maxFiles}`,
      413,
    );
  }
  const files = new Map<string, string>();
  for (const file of request.files) files.set(sanitizePath(file.path), file.content);
  // Raw contents only live in memory for the duration of this request.
  return toJsonReport(await scanFiles(new MemoryFileProvider(files), options));
}
