import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeSwiftUrl,
  parsePackageResolved,
  parsePackageSwift,
} from '../src/ecosystems/swift/index.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { collectSubprojects } from '../src/sources/discover.js';
import { FIXTURES } from './helpers.js';

describe('Package.resolved', () => {
  it('reads v3 pins and marks direct pins from Package.swift', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'swift/app')),
    );
    const { graph, warnings, ecosystem } = subprojects[0]!;
    expect(ecosystem).toBe('SwiftURL');
    expect([...graph.nodes.keys()].sort()).toEqual([
      'github.com/apple/swift-nio@2.30.0',
      'github.com/swift-server/async-http-client@1.5.0',
      'github.com/vapor/vapor@4.50.0',
    ]);
    expect(graph.nodes.get('github.com/apple/swift-nio@2.30.0')).toMatchObject({
      isDirect: true,
      confidence: 'high',
    });
    expect(graph.nodes.get('github.com/swift-server/async-http-client@1.5.0')!.isDirect).toBe(
      false,
    );
    expect(warnings.map((w) => w.code)).toEqual(['non-registry-version']);
  });

  it('reads the v1 layout', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'swift/legacy-v1')),
    );
    const { graph } = subprojects[0]!;
    expect([...graph.nodes.keys()]).toEqual(['github.com/Alamofire/Alamofire@5.0.0']);
    expect(graph.nodes.values().next().value!.isDirect).toBe(true);
  });

  it('reads v2 pins with a v-prefixed version', () => {
    const json = JSON.stringify({
      version: 2,
      pins: [{ identity: 'a', location: 'https://github.com/x/a', state: { version: 'v1.2.3' } }],
    });
    expect([...parsePackageResolved(json, 'Package.resolved', 'r').graph.nodes.keys()]).toEqual([
      'github.com/x/a@1.2.3',
    ]);
  });

  it('normalizes repository URLs like OSV SwiftURL names', () => {
    expect(normalizeSwiftUrl('https://github.com/apple/swift-nio.git')).toBe(
      'github.com/apple/swift-nio',
    );
    expect(normalizeSwiftUrl('git@github.com:acme/lib.git')).toBe('github.com/acme/lib');
    expect(normalizeSwiftUrl('ssh://git@host.example:7999/a/b.git/')).toBe('host.example:7999/a/b');
    expect(normalizeSwiftUrl('https://user@gitlab.com/g/p')).toBe('gitlab.com/g/p');
    expect([
      ...parsePackageSwift('.package(name: "N", url: "https://github.com/a/b.git", from: "1.0.0")'),
    ]).toEqual(['github.com/a/b']);
  });

  it('does not throw on malformed input', () => {
    for (const junk of ['', '{', 'null', '{"pins": 3}', '{"pins":[null,{}]}', '[]']) {
      expect(() => parsePackageResolved(junk, 'Package.resolved', 'r')).not.toThrow();
    }
    expect(parsePackageResolved('{', 'Package.resolved', 'r').warnings[0]!.code).toBe(
      'malformed-lockfile',
    );
  });
});
