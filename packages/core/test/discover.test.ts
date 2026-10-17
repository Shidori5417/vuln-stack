import { describe, expect, it } from 'vitest';
import {
  collectSubprojects,
  discoverProjects,
  dropWorkspaceMembers,
  isIgnoredPath,
} from '../src/sources/discover.js';
import { basename, dirname, joinPath, MemoryFileProvider } from '../src/sources/file-provider.js';

describe('discoverProjects', () => {
  it('groups files per folder and skips ignored folders', () => {
    const projects = discoverProjects([
      'package.json',
      'package-lock.json',
      'packages/a/package.json',
      'node_modules/x/package.json',
      'README.md',
    ]);
    expect(projects.map((p) => [p.dir, p.hasLock, p.files])).toEqual([
      ['', true, ['package.json', 'package-lock.json']],
      ['packages/a', false, ['packages/a/package.json']],
    ]);
  });

  it('detects ignored paths', () => {
    expect(isIgnoredPath('a/node_modules/b/package.json')).toBe(true);
    expect(isIgnoredPath('src/package.json')).toBe(false);
  });
});

describe('dropWorkspaceMembers', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: { '': {}, 'packages/a': { version: '1.0.0' } },
  });

  it('drops workspace members covered by an ancestor lock but keeps independent projects', async () => {
    const provider = new MemoryFileProvider({
      'package.json': '{}',
      'package-lock.json': lock,
      'packages/a/package.json': '{}',
      'tools/standalone/package.json': '{}',
    });
    const kept = await dropWorkspaceMembers(discoverProjects(await provider.list()), provider);
    expect(kept.map((p) => p.dir)).toEqual(['', 'tools/standalone']);
  });

  it('handles nested locks relative to their own folder', async () => {
    const provider = new MemoryFileProvider({
      'apps/web/package-lock.json': JSON.stringify({ packages: { 'libs/ui': {} } }),
      'apps/web/package.json': '{}',
      'apps/web/libs/ui/package.json': '{}',
      'apps/api/package.json': '{}',
    });
    const kept = await dropWorkspaceMembers(discoverProjects(await provider.list()), provider);
    expect(kept.map((p) => p.dir)).toEqual(['apps/api', 'apps/web']);
  });

  it('keeps members when the lock is unreadable or v1', async () => {
    const provider = new MemoryFileProvider({
      'npm-shrinkwrap.json': '{ broken',
      'package.json': '{}',
      'a/package.json': '{}',
    });
    const kept = await dropWorkspaceMembers(discoverProjects(await provider.list()), provider);
    expect(kept.map((p) => p.dir)).toEqual(['', 'a']);
  });
});

describe('collectSubprojects', () => {
  it('parses each project and turns parse errors into warnings', async () => {
    const provider = new MemoryFileProvider({
      'good/package.json': JSON.stringify({ name: 'good', dependencies: { a: '1.0.0' } }),
      'bad/package.json': '{ not json',
    });
    const { subprojects, warnings } = await collectSubprojects(provider);
    expect(subprojects.map((s) => s.graph.root)).toEqual(['good']);
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'parse-error', file: 'bad/package.json' }),
    ]);
  });

  it('warns when nothing is found', async () => {
    const { warnings } = await collectSubprojects(new MemoryFileProvider({ 'a.txt': '' }));
    expect(warnings[0]!.code).toBe('no-manifests');
  });

  it('names root projects without a name field', async () => {
    const { subprojects } = await collectSubprojects(
      new MemoryFileProvider({ 'package.json': '{}', 'sub/dir/package.json': '{}' }),
    );
    expect(subprojects.map((s) => s.graph.root)).toEqual(['root', 'dir']);
  });
});

describe('MemoryFileProvider and path helpers', () => {
  it('reads and fails on missing files', async () => {
    const p = new MemoryFileProvider(new Map([['a', 'x']]));
    expect(await p.read('a')).toBe('x');
    await expect(p.read('b')).rejects.toThrow(/not found/);
  });

  it('handles paths', () => {
    expect(dirname('a/b/c.json')).toBe('a/b');
    expect(dirname('c.json')).toBe('');
    expect(basename('a/b/c.json')).toBe('c.json');
    expect(joinPath('', 'x')).toBe('x');
    expect(joinPath('a', 'x')).toBe('a/x');
  });
});
