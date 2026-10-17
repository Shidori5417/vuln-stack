import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CacheStore } from '../cache/types.js';

interface Entry {
  expiresAt: number;
  value: unknown;
}

export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'vulnstack');
}

/** One JSON file per key under the cache dir. Good enough for CLI-sized workloads. */
export class FileCache implements CacheStore {
  private ready: Promise<unknown> | undefined;

  constructor(
    private readonly dir: string = defaultCacheDir(),
    private readonly now: () => number = Date.now,
  ) {}

  private file(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex');
    return join(this.dir, hash.slice(0, 2), `${hash}.json`);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.file(key), 'utf8')) as Entry;
      return entry.expiresAt > this.now() ? (entry.value as T) : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const file = this.file(key);
    const dir = file.slice(0, file.lastIndexOf('/'));
    try {
      this.ready ??= mkdir(this.dir, { recursive: true });
      await this.ready;
      await mkdir(dir, { recursive: true });
      // Write-then-rename so concurrent readers never see half a file.
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify({ expiresAt: this.now() + ttlSeconds * 1000, value }));
      await rename(tmp, file);
    } catch {
      // A cache that can't be written must never fail a scan.
    }
  }
}
