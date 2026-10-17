import pLimit from 'p-limit';
import { ALL_SUPPORTED_PATTERNS } from '../ecosystems/files.js';
import { defaultPlugins } from '../ecosystems/registry.js';
import type { ScanResult, Warning } from '../model/types.js';
import type { FetchFn } from '../net/context.js';
import { scanSubprojects, type ScanOptions } from '../scan.js';
import { VERSION } from '../version.js';
import { collectSubprojects, isIgnoredPath } from './discover.js';
import { basename, type FileProvider } from './file-provider.js';
import { matchesAny } from './match.js';

export interface GitHubRef {
  owner: string;
  repo: string;
  ref?: string;
  subdir?: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

function validated(owner: string, repo: string, rest: string[], input: string): GitHubRef {
  const cleanRepo = repo.replace(/\.git$/, '');
  if (!NAME.test(owner) || !NAME.test(cleanRepo) || cleanRepo === '.' || cleanRepo === '..') {
    throw new Error(`Not a GitHub repository: "${input}"`);
  }
  const result: GitHubRef = { owner, repo: cleanRepo };
  const [kind, ref, ...dir] = rest;
  if (kind === 'tree' || kind === 'blob') {
    if (ref) result.ref = decodeURIComponent(ref);
    const subdir = dir.map(decodeURIComponent).join('/');
    if (subdir) result.subdir = subdir;
  }
  return result;
}

/**
 * Accepts `https://github.com/o/r[/tree/<ref>[/<dir>]]`, `github.com/o/r`,
 * `o/r` and `git@github.com:o/r.git`. A ref containing slashes is ambiguous in
 * tree URLs; only the first segment is taken as the ref.
 */
export function parseGitHubUrl(input: string): GitHubRef {
  const text = input.trim();
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/.exec(text);
  if (ssh) return validated(ssh[1]!, ssh[2]!.replace(/\/+$/, ''), [], input);

  let path: string | undefined;
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(text);
  if (url) path = url[1]!;
  else if (/^[^/\s:@]+\/[^/\s:@]+$/.test(text)) path = text;
  if (path === undefined) throw new Error(`Not a GitHub repository: "${input}"`);

  const segments = path.split(/[?#]/)[0]!.split('/').filter(Boolean);
  if (segments.length < 2) throw new Error(`Not a GitHub repository: "${input}"`);
  const [owner, repo, ...rest] = segments as [string, string, ...string[]];
  return validated(owner, repo, rest, input);
}

export interface GitHubProviderOptions extends GitHubRef {
  token?: string;
  fetch: FetchFn;
  apiBase?: string;
  userAgent?: string;
  signal?: AbortSignal;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

const READ_CONCURRENCY = 8;

/** Reads supported manifest files of a GitHub repository through the REST API (Node and browsers). */
export class GitHubFileProvider implements FileProvider {
  /** Filled while listing / reading; add them to the scan result. */
  readonly warnings: Warning[] = [];

  private readonly o: GitHubProviderOptions;
  private readonly apiBase: string;
  private readonly subdir: string;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly limit = pLimit(READ_CONCURRENCY);
  private files?: Promise<Map<string, TreeEntry>>;
  private totalBytes = 0;
  private resolvedRef?: string;

  constructor(options: GitHubProviderOptions) {
    this.o = options;
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.subdir = (options.subdir ?? '').replace(/^\/+|\/+$/g, '');
    this.maxFiles = options.maxFiles ?? 200;
    this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 30 * 1024 * 1024;
  }

  /** The branch/tag/sha that was scanned (known after `list()`). */
  get ref(): string | undefined {
    return this.resolvedRef;
  }

  private async api<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.o.userAgent ?? `vulnstack/${VERSION}`,
    };
    if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
    const init: RequestInit = { headers };
    if (this.o.signal) init.signal = this.o.signal;
    const response = await this.o.fetch(`${this.apiBase}${path}`, init);
    if (response.ok) return (await response.json()) as T;

    const { owner, repo } = this.o;
    switch (response.status) {
      case 401:
        throw new Error('GitHub rejected the access token (invalid or expired)');
      case 404:
        throw new Error('Repository not found or private (sign in / provide a token)');
      case 403:
      case 429: {
        if (response.headers.get('x-ratelimit-remaining') === '0') {
          const reset = Number(response.headers.get('x-ratelimit-reset'));
          const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
          throw new Error(
            `GitHub API rate limit exceeded${when ? `; resets at ${when.toISOString()}` : ''}` +
              (this.o.token ? '' : ' (provide a token for a higher limit)'),
          );
        }
        throw new Error(`GitHub denied access to ${owner}/${repo} (HTTP ${response.status})`);
      }
      default:
        throw new Error(`GitHub API error ${response.status} for ${owner}/${repo}`);
    }
  }

  private load(): Promise<Map<string, TreeEntry>> {
    this.files ??= this.fetchTree();
    return this.files;
  }

  private async fetchTree(): Promise<Map<string, TreeEntry>> {
    const { owner, repo } = this.o;
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    let ref = this.o.ref;
    if (!ref) {
      const info = await this.api<{ default_branch?: string }>(base);
      ref = info.default_branch ?? 'HEAD';
    }
    this.resolvedRef = ref;
    const tree = await this.api<{ tree?: TreeEntry[]; truncated?: boolean }>(
      `${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    );
    if (tree.truncated) {
      this.warnings.push({
        code: 'github-tree-truncated',
        message:
          'The repository is too large for GitHub to list completely; some files were skipped',
      });
    }

    const prefix = this.subdir ? `${this.subdir}/` : '';
    const matches: [string, TreeEntry][] = [];
    for (const entry of tree.tree ?? []) {
      if (entry.type !== 'blob' || !entry.path.startsWith(prefix)) continue;
      const rel = entry.path.slice(prefix.length);
      if (isIgnoredPath(rel) || !matchesAny(ALL_SUPPORTED_PATTERNS, basename(rel))) continue;
      matches.push([rel, entry]);
    }
    matches.sort((a, b) => a[0].localeCompare(b[0]));
    if (matches.length > this.maxFiles) {
      this.warnings.push({
        code: 'github-file-cap',
        message: `Found ${matches.length} dependency files; only the first ${this.maxFiles} are scanned`,
      });
      matches.length = this.maxFiles;
    }
    return new Map(matches);
  }

  async list(): Promise<string[]> {
    return [...(await this.load()).keys()];
  }

  async read(path: string): Promise<string> {
    const entry = (await this.load()).get(path);
    if (!entry) throw new Error(`File not found: ${path}`);
    if (entry.size !== undefined && entry.size > this.maxFileBytes) {
      throw new Error(`${path} is larger than ${this.maxFileBytes} bytes`);
    }
    return this.limit(async () => {
      const { owner, repo } = this.o;
      const blob = await this.api<{ content?: string; encoding?: string; size?: number }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${entry.sha}`,
      );
      const size = blob.size ?? entry.size ?? 0;
      if (size > this.maxFileBytes)
        throw new Error(`${path} is larger than ${this.maxFileBytes} bytes`);
      this.totalBytes += size;
      if (this.totalBytes > this.maxTotalBytes) {
        throw new Error(
          `Total size limit of ${this.maxTotalBytes} bytes exceeded while reading ${path}`,
        );
      }
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
        throw new Error(`Unexpected blob encoding for ${path}`);
      }
      return decodeBase64Utf8(blob.content);
    });
  }
}

export interface GitHubScanOptions extends ScanOptions {
  token?: string;
  apiBase?: string;
  maxFiles?: number;
}

/** Scans a GitHub repository (or a sub-folder of it) without cloning. */
export async function scanGitHubRepo(
  input: string,
  options: GitHubScanOptions = {},
): Promise<ScanResult> {
  const ref = parseGitHubUrl(input);
  const providerOptions: GitHubProviderOptions = {
    ...ref,
    fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
  };
  if (options.token) providerOptions.token = options.token;
  if (options.apiBase) providerOptions.apiBase = options.apiBase;
  if (options.userAgent) providerOptions.userAgent = options.userAgent;
  if (options.signal) providerOptions.signal = options.signal;
  if (options.maxFiles) providerOptions.maxFiles = options.maxFiles;
  const provider = new GitHubFileProvider(providerOptions);

  options.onProgress?.('parse');
  const { subprojects, warnings } = await collectSubprojects(
    provider,
    options.plugins ?? defaultPlugins,
  );
  return scanSubprojects(subprojects, options, [...provider.warnings, ...warnings]);
}
