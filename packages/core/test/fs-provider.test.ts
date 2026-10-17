import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { FIXTURES } from './helpers.js';

describe('FsFileProvider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vulnstack-fs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lists files with POSIX paths, skipping ignored dirs', async () => {
    const files = await new FsFileProvider(join(FIXTURES, 'npm/workspaces')).list();
    expect(files.sort()).toEqual([
      'package-lock.json',
      'package.json',
      'packages/api/package.json',
      'packages/web/package.json',
    ]);
  });

  it('respects depth, file count and size limits, and skips symlinks', async () => {
    mkdirSync(join(dir, 'a/b/c'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules/x.json'), '');
    writeFileSync(join(dir, 'top.json'), '0123456789');
    writeFileSync(join(dir, 'a/b/c/deep.json'), '');
    symlinkSync(join(dir, 'top.json'), join(dir, 'link.json'));

    expect((await new FsFileProvider(dir).list()).sort()).toEqual(['a/b/c/deep.json', 'top.json']);
    expect(await new FsFileProvider(dir, { maxDepth: 1 }).list()).toEqual(['top.json']);
    expect(await new FsFileProvider(dir, { maxFiles: 1 }).list()).toHaveLength(1);
    await expect(new FsFileProvider(dir, { maxFileSize: 5 }).read('top.json')).rejects.toThrow(
      /larger than/,
    );
    expect(await new FsFileProvider(dir).read('top.json')).toBe('0123456789');
  });

  it('refuses paths outside the root and tolerates missing roots', async () => {
    await expect(new FsFileProvider(dir).read('../etc/passwd')).rejects.toThrow(/escapes root/);
    expect(await new FsFileProvider(join(dir, 'nope')).list()).toEqual([]);
  });
});
