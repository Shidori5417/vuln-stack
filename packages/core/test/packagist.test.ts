import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainNames, computePaths } from '../src/model/graph.js';
import { parseComposerConstraint } from '../src/ecosystems/packagist/constraints.js';
import {
  composerManifestGraph,
  isPlatformPackage,
  packagistPlugin,
  parseComposerLock,
} from '../src/ecosystems/packagist/index.js';
import { collectSubprojects } from '../src/sources/discover.js';
import { MemoryFileProvider } from '../src/sources/file-provider.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { MemoryCache } from '../src/cache/memory.js';
import { FIXTURES, json } from './helpers.js';

describe('Composer constraints', () => {
  const ok = (c: string, yes: string[], no: string[]) => {
    const m = parseComposerConstraint(c)!;
    expect(m, c).toBeDefined();
    for (const v of yes) expect(m(v), `${c} ⊇ ${v}`).toBe(true);
    for (const v of no) expect(m(v), `${c} ∌ ${v}`).toBe(false);
  };

  it('supports caret, tilde, wildcard, hyphen, OR and comparison operators', () => {
    ok('^4.4', ['4.4.0', 'v4.4.49', '4.9.9'], ['4.3.9', '5.0.0']);
    ok('^0.3', ['0.3.0', '0.3.9'], ['0.4.0']);
    ok('^0.0.3', ['0.0.3'], ['0.0.4']);
    ok('^0', ['0.9.9'], ['1.0.0']);
    ok('~1.2', ['1.2.0', '1.9.0'], ['2.0.0', '1.1.9']);
    ok('~1.2.3', ['1.2.3', '1.2.9'], ['1.3.0']);
    ok('1.2.*', ['1.2.0', '1.2.99'], ['1.3.0', '1.1.0']);
    ok('*', ['0.0.1'], ['dev-master']);
    ok('1.0 - 2.0', ['1.0.0', '2.0.9'], ['2.1.0', '0.9']);
    ok('1.0.0 - 2.1.0', ['2.1.0'], ['2.1.1']);
    ok('^1.0 || ^2.0', ['1.5', '2.5'], ['3.0']);
    ok('^1.0|^2.0', ['2.0'], ['0.9']);
    ok('>=1.0 <1.5', ['1.4.9'], ['1.5']);
    ok('>=1.0,<=1.5,!=1.2', ['1.5', '1.0'], ['1.2', '1.6']);
    ok('>1.0', ['1.0.1'], ['1.0']);
    ok('=1.0.0', ['1.0'], ['1.0.1']);
    ok('v1.0.0@stable', ['1.0.0'], []);
  });

  it('rejects branch constraints', () => {
    expect(parseComposerConstraint('dev-main')).toBeUndefined();
    expect(parseComposerConstraint('^1.0 || dev-master')).toBeUndefined();
    expect(parseComposerConstraint('>=nope')).toBeUndefined();
  });
});

describe('composer.lock', () => {
  it('reads packages, dev packages and chains; skips platform deps and branches', async () => {
    const { subprojects, warnings } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'packagist/laravel-app')),
    );
    const { graph, warnings: subWarnings } = subprojects[0]!;
    expect(graph.root).toBe('acme/laravel-app');
    expect(graph.nodes.get('symfony/http-kernel@4.4.0')).toMatchObject({
      isDirect: true,
      scope: 'prod',
    });
    expect(graph.nodes.get('phpunit/phpunit@9.5.0')).toMatchObject({
      isDirect: true,
      scope: 'dev',
    });
    const paths = computePaths(graph);
    expect(chainNames(graph, paths.get('psr/http-message@1.0.1')!.path)).toEqual([
      'acme/laravel-app',
      'guzzlehttp/guzzle',
      'guzzlehttp/psr7',
      'psr/http-message',
    ]);
    expect([...warnings, ...subWarnings].map((w) => w.code)).toEqual(['non-registry-version']);
  });

  it('infers direct dependencies without composer.json', () => {
    const { graph } = parseComposerLock(
      JSON.stringify({
        packages: [
          { name: 'A/B', version: '1.0', require: { 'c/d': '*' } },
          { name: 'c/d', version: '2.0' },
        ],
      }),
      'composer.lock',
      'x',
    );
    expect(graph.nodes.get('a/b@1.0')!.isDirect).toBe(true);
    expect(graph.nodes.get('c/d@2.0')!.isDirect).toBe(false);
    expect(() => parseComposerLock('{', 'composer.lock', 'x')).toThrow(/invalid JSON/);
  });

  it('builds a manifest graph when there is no lock', () => {
    const { graph, warnings } = composerManifestGraph(
      {
        require: { php: '^8', 'Vendor/Pkg': '^1.0', 'a/b': 'dev-main' },
        'require-dev': { 'c/d': '~2.0' },
      },
      'composer.json',
      'app',
    );
    expect([...graph.nodes.values()].map((d) => `${d.name}:${d.declaredRange}:${d.scope}`)).toEqual(
      ['vendor/pkg:^1.0:prod', 'c/d:~2.0:dev'],
    );
    expect(warnings.map((w) => w.code)).toEqual(['non-registry-version', 'no-lockfile']);
    expect(isPlatformPackage('ext-json')).toBe(true);
  });

  it('parses manifest-only folders through the plugin', async () => {
    const { subprojects } = await collectSubprojects(
      new MemoryFileProvider({ 'composer.json': '{"require":{"a/b":"^1"}}' }),
    );
    expect(subprojects[0]!.graph.nodes.get('a/b@')!.declaredRange).toBe('^1');
    expect(
      (
        await packagistPlugin.parse({
          dir: '',
          files: [],
          provider: new MemoryFileProvider({}),
          allFiles: [],
        })
      ).subprojects,
    ).toEqual([]);
  });
});

describe('Packagist resolution', () => {
  it('picks the highest stable version matching the constraint', async () => {
    const calls: string[] = [];
    const net = {
      cache: new MemoryCache(),
      userAgent: 't',
      fetch: async (url: string) => {
        calls.push(url);
        return json({
          packages: {
            'symfony/http-kernel': [
              { version: 'v4.4.0' },
              { version: 'v4.4.50' },
              { version: 'v5.0.0' },
              { version: 'v4.4.51-RC1' },
              { version: 'dev-main' },
              {},
            ],
          },
        });
      },
    };
    expect(await packagistPlugin.resolveRange!('symfony/http-kernel', '^4.4', net)).toBe('4.4.50');
    expect(await packagistPlugin.resolveRange!('symfony/http-kernel', '^4.4@RC', net)).toBe(
      '4.4.51-RC1',
    );
    expect(await packagistPlugin.resolveRange!('symfony/http-kernel', '^9', net)).toBeNull();
    expect(await packagistPlugin.resolveRange!('symfony/http-kernel', 'dev-main', net)).toBeNull();
    expect(calls).toEqual(['https://repo.packagist.org/p2/symfony/http-kernel.json']);
  });
});
