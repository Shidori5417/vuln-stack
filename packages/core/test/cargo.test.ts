import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cargoManifestGraph, cargoPlugin, parseCargoLock } from '../src/ecosystems/cargo/index.js';
import { semverVersioning as v } from '../src/ecosystems/shared.js';
import { chainNames, computePaths } from '../src/model/graph.js';
import { MemoryCache } from '../src/cache/memory.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { collectSubprojects } from '../src/sources/discover.js';
import { MemoryFileProvider } from '../src/sources/file-provider.js';
import { FIXTURES, json } from './helpers.js';

describe('Cargo.lock', () => {
  it('builds edges, marks direct, dev and skips git sources', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'cargo/app')),
    );
    const { graph, warnings } = subprojects[0]!;
    expect(subprojects[0]!.ecosystem).toBe('crates.io');
    expect(graph.root).toBe('demo-app');
    expect(graph.nodes.get('demo-app@0.1.0')!.internal).toBe(true);
    expect(graph.nodes.get('util-from-git@0.2.0')!.internal).toBe(true);
    const direct = [...graph.nodes.values()].filter((d) => d.isDirect).map((d) => d.name);
    expect(direct.sort()).toEqual(['regex', 'serde', 'tempfile', 'time']);
    expect(graph.nodes.get('tempfile@3.2.0')!.scope).toBe('dev');
    // libc is also reached through time (prod), so it stays prod.
    expect(graph.nodes.get('libc@0.2.101')!.scope).toBe('prod');
    expect(graph.nodes.get('regex@1.5.4')).toMatchObject({ scope: 'prod', confidence: 'high' });
    const paths = computePaths(graph);
    expect(chainNames(graph, paths.get('memchr@2.4.1')!.path)).toEqual([
      'demo-app',
      'regex',
      'memchr',
    ]);
    expect(warnings.map((w) => w.code)).toEqual(['non-registry-version']);
  });

  it('marks packages only reachable from dev dependencies as dev', () => {
    const lock = `
[[package]]
name = "app"
version = "1.0.0"
dependencies = ["a", "d"]

[[package]]
name = "a"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "d"
version = "2.0.0"
source = "sparse+https://index.crates.io/"
dependencies = ["e 1.0.0"]

[[package]]
name = "e"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
    const { graph } = parseCargoLock(lock, 'Cargo.lock', 'app', {
      dependencies: { a: '1' },
      'dev-dependencies': { d: '2' },
    });
    expect(graph.nodes.get('d@2.0.0')!.scope).toBe('dev');
    expect(graph.nodes.get('e@1.0.0')!.scope).toBe('dev');
    expect(graph.nodes.get('a@1.0.0')!.scope).toBe('prod');
  });

  it('does not throw on malformed input', () => {
    for (const junk of ['', '= = =', '[[package]]\nname = 1\n', '[package]\nfoo = "bar"']) {
      expect(() => parseCargoLock(junk, 'Cargo.lock', 'x')).not.toThrow();
    }
    expect(parseCargoLock('= = =', 'Cargo.lock', 'x').warnings[0]!.code).toBe('malformed-lockfile');
  });
});

describe('Cargo.toml fallback', () => {
  it('collects requirements with the no-lockfile warning and skips path/git', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'cargo/manifest-only')),
    );
    const { graph, warnings } = subprojects[0]!;
    expect([...graph.nodes.values()].map((d) => `${d.name}:${d.declaredRange}:${d.scope}`)).toEqual(
      ['serde:1.0:prod', 'regex:>=1.5, <1.6:prod', 'tempfile:3:dev'],
    );
    expect(graph.nodes.get('serde@')!.confidence).toBe('medium');
    expect(warnings.map((w) => w.code).sort()).toEqual(['no-lockfile', 'non-registry-version']);
    expect(() => cargoManifestGraph({}, 'Cargo.toml', 'x')).not.toThrow();
  });

  it('resolves ranges against the crates.io API, skipping yanked and pre-releases', async () => {
    const net = {
      fetch: async () =>
        json({
          versions: [
            { num: '1.0.200' },
            { num: '1.0.210', yanked: true },
            { num: '1.1.0-beta.1' },
            { num: '2.0.0' },
          ],
        }),
      cache: new MemoryCache(),
      userAgent: 'test',
    };
    expect(await cargoPlugin.resolveRange!('serde', '1.0', net as never)).toBe('1.0.200');
    expect(await cargoPlugin.resolveRange!('serde', 'nonsense!!', net as never)).toBeNull();
  });

  it('treats a manifest-only member as covered by an ancestor lock', async () => {
    const provider = new MemoryFileProvider({
      'Cargo.lock': '[[package]]\nname = "member"\nversion = "0.1.0"\n',
      'crates/member/Cargo.toml': '[package]\nname = "member"\nversion = "0.1.0"\n',
    });
    expect(await cargoPlugin.isCoveredByLock!('', 'crates/member', provider)).toBe(true);
  });
});

describe('semver versioning (Cargo/Pub/Hex/Swift)', () => {
  it('orders pre-releases and ignores build metadata', () => {
    expect(['1.0.0', '1.0.0-rc.1', '0.9.0', '1.0.0-alpha'].sort(v.compare)).toEqual([
      '0.9.0',
      '1.0.0-alpha',
      '1.0.0-rc.1',
      '1.0.0',
    ]);
    expect(v.compare('1.0.0+1', '1.0.0+2')).toBe(0);
    expect(v.compare('v1.2.3', '1.2.3')).toBe(0);
    expect(v.compare('junk', '1.0.0')).toBeLessThan(0);
  });

  it('flags 0.x minor and major bumps as breaking', () => {
    expect(v.isMajorBump('0.1.43', '0.2.0')).toBe(true);
    expect(v.isMajorBump('0.1.43', '0.1.45')).toBe(false);
    expect(v.isMajorBump('1.5.4', '1.9.0')).toBe(false);
    expect(v.isMajorBump('1.5.4', '2.0.0')).toBe(true);
    expect(v.isMajorBump('x', '1.0.0')).toBe(true);
  });
});
