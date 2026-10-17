import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { IGNORED_DIRS } from '../sources/discover.js';
import type { FileProvider } from '../sources/file-provider.js';

export interface FsProviderOptions {
  maxDepth?: number;
  maxFiles?: number;
  /** Files larger than this are refused on read (bytes). */
  maxFileSize?: number;
}

/** Walks a local folder, skipping vendored/build directories and symlinks. */
export class FsFileProvider implements FileProvider {
  private readonly maxDepth: number;
  private readonly maxFiles: number;
  private readonly maxFileSize: number;

  constructor(
    private readonly root: string,
    options: FsProviderOptions = {},
  ) {
    this.maxDepth = options.maxDepth ?? 12;
    this.maxFiles = options.maxFiles ?? 50_000;
    this.maxFileSize = options.maxFileSize ?? 64 * 1024 * 1024;
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > this.maxDepth || out.length >= this.maxFiles) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (out.length >= this.maxFiles) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) await walk(full, depth + 1);
        } else if (entry.isFile()) {
          out.push(relative(this.root, full).split(sep).join('/'));
        }
      }
    };
    await walk(this.root, 0);
    return out;
  }

  async read(path: string): Promise<string> {
    const full = join(this.root, ...path.split('/'));
    if (relative(this.root, full).startsWith('..')) throw new Error(`Path escapes root: ${path}`);
    const info = await stat(full);
    if (info.size > this.maxFileSize)
      throw new Error(`${path} is larger than ${this.maxFileSize} bytes`);
    return readFile(full, 'utf8');
  }
}
