import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManualInput } from '../src/sources/manual.js';
import { parsePubspecLock } from '../src/ecosystems/pub/index.js';
import { semverVersioning as v } from '../src/ecosystems/shared.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { collectSubprojects } from '../src/sources/discover.js';
import { FIXTURES } from './helpers.js';

describe('pubspec.lock', () => {
  it('reads direct main/dev and transitive packages, skipping sdk and git', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'pub/flutter-app')),
    );
    const { graph, warnings, ecosystem } = subprojects[0]!;
    expect(ecosystem).toBe('Pub');
    expect([...graph.nodes.keys()].sort()).toEqual([
      'archive@3.1.2',
      'http@0.13.0',
      'lints@2.0.1',
      'path@1.8.3',
    ]);
    expect(graph.nodes.get('http@0.13.0')).toMatchObject({
      isDirect: true,
      scope: 'prod',
      confidence: 'high',
    });
    expect(graph.nodes.get('lints@2.0.1')).toMatchObject({ isDirect: true, scope: 'dev' });
    expect(graph.nodes.get('archive@3.1.2')).toMatchObject({ isDirect: false, scope: 'prod' });
    expect(graph.nodes.get('archive@3.1.2')!.sourceFile).toBe('pubspec.lock');
    expect(warnings.map((w) => w.code)).toEqual(['non-registry-version', 'non-registry-version']);
  });

  it('treats a custom pub host as non-registry', () => {
    const lock = `packages:
  x:
    dependency: "direct main"
    description: { name: x, url: "https://pub.example.com" }
    source: hosted
    version: "1.0.0"
`;
    const { graph, warnings } = parsePubspecLock(lock, 'pubspec.lock', 'r');
    expect(graph.nodes.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  it('does not throw on malformed input', () => {
    for (const junk of ['', ':::\n- [', 'packages: 5', 'packages:\n  a: 3', 'packages: [1]']) {
      expect(() => parsePubspecLock(junk, 'pubspec.lock', 'r')).not.toThrow();
    }
    expect(parsePubspecLock('a: [', 'pubspec.lock', 'r').warnings[0]!.code).toBe(
      'malformed-lockfile',
    );
  });

  it('uses semver for remediation', () => {
    expect(v.isMajorBump('0.13.0', '1.0.0')).toBe(true);
    expect(v.isMajorBump('1.1.0', '1.2.0+3')).toBe(false);
  });
});

describe('manual input prefixes for new ecosystems', () => {
  it('accepts ecosystem aliases', () => {
    const { entries, errors } = parseManualInput(
      'crates.io:serde@1.0.130, gem:rails 5.2.2, hex:plug@1.10.0, pub:http@0.13.0, swift:github.com/apple/swift-nio@2.30.0',
    );
    expect(errors).toEqual([]);
    expect(entries.map((e) => `${e.ecosystem}:${e.name}@${e.version}`)).toEqual([
      'crates.io:serde@1.0.130',
      'RubyGems:rails@5.2.2',
      'Hex:plug@1.10.0',
      'Pub:http@0.13.0',
      'SwiftURL:github.com/apple/swift-nio@2.30.0',
    ]);
  });
});
