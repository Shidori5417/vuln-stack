import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePackageLock } from '../src/ecosystems/npm/package-lock.js';
import { computePaths, chainNames } from '../src/model/graph.js';
import { FIXTURES } from './helpers.js';

const read = (p: string) => readFileSync(join(FIXTURES, 'npm', p), 'utf8');

describe('package-lock v3', () => {
  const { graph, warnings } = parsePackageLock(
    read('lock-v3-express/package-lock.json'),
    'package-lock.json',
    'fallback',
  );

  it('reads every registry package with exact versions', () => {
    expect(graph.root).toBe('my-app');
    expect(graph.nodes.size).toBe(52);
    expect(graph.nodes.get('express@4.17.1')).toMatchObject({
      isDirect: true,
      confidence: 'high',
      scope: 'prod',
    });
    expect(graph.nodes.get('minimist@1.2.0')).toMatchObject({ isDirect: true, scope: 'dev' });
    expect(graph.nodes.get('body-parser@1.19.0')).toMatchObject({ isDirect: false });
    expect(warnings).toEqual([]);
  });

  it('builds transitive chains', () => {
    const paths = computePaths(graph);
    expect(chainNames(graph, paths.get('body-parser@1.19.0')!.path)).toEqual([
      'my-app',
      'express',
      'body-parser',
    ]);
    const qs = [...graph.nodes.keys()].find((k) => k.startsWith('qs@'))!;
    expect(chainNames(graph, paths.get(qs)!.path)).toEqual(['my-app', 'express', 'qs']);
  });
});

describe('package-lock workspaces', () => {
  const { graph } = parsePackageLock(
    read('workspaces/package-lock.json'),
    'package-lock.json',
    'x',
  );

  it('keeps both versions of a hoisted/nested package and models members as internal nodes', () => {
    expect(graph.nodes.has('minimist@1.2.5')).toBe(true);
    expect(graph.nodes.has('minimist@0.0.8')).toBe(true);
    const members = [...graph.nodes.values()].filter((d) => d.name.startsWith('@ws/'));
    expect(members.map((m) => [m.name, m.internal])).toEqual([
      ['@ws/api', true],
      ['@ws/web', true],
    ]);
  });

  it('routes chains through the workspace member', () => {
    const paths = computePaths(graph);
    expect(chainNames(graph, paths.get('minimist@0.0.8')!.path)).toEqual([
      'ws-root',
      '@ws/web',
      'minimist',
    ]);
    expect(chainNames(graph, paths.get('minimist@1.2.5')!.path)).toEqual(['ws-root', 'minimist']);
    const jws = [...graph.nodes.keys()].find((k) => k.startsWith('jws@'))!;
    expect(chainNames(graph, paths.get(jws)!.path)).toEqual([
      'ws-root',
      '@ws/api',
      'jsonwebtoken',
      'jws',
    ]);
  });

  it('marks dependencies of every workspace member as direct', () => {
    expect(graph.nodes.get('minimist@0.0.8')!.isDirect).toBe(true);
    expect(graph.nodes.get('jsonwebtoken@8.5.1')!.isDirect).toBe(true);
    const jws = [...graph.nodes.values()].find((d) => d.name === 'jws')!;
    expect(jws.isDirect).toBe(false);
  });
});

describe('package-lock v1', () => {
  it('resolves nested dependencies and requires', () => {
    const { graph, warnings } = parsePackageLock(
      read('lock-v1/package-lock.json'),
      'package-lock.json',
      'x',
      new Set(['mkdirp', 'minimist']),
    );
    expect(graph.root).toBe('legacy-app');
    expect([...graph.edges.get('mkdirp@0.5.1')!]).toEqual(['minimist@0.0.8']);
    expect(graph.nodes.get('minimist@0.0.8')!.isDirect).toBe(false);
    expect(graph.nodes.get('minimist@1.2.5')!.isDirect).toBe(true);
    expect(warnings.map((w) => w.code)).toEqual(['non-registry-version']);
  });

  it('guesses direct dependencies without package.json', () => {
    const { graph, warnings } = parsePackageLock(
      read('lock-v1/package-lock.json'),
      'package-lock.json',
      'x',
    );
    expect(graph.nodes.get('mkdirp@0.5.1')!.isDirect).toBe(true);
    expect(graph.nodes.get('minimist@1.2.5')!.isDirect).toBe(true);
    expect(warnings.map((w) => w.code)).toContain('lockfile-v1-direct-guess');
  });
});

describe('package-lock edge cases', () => {
  it('rejects invalid JSON with the file name', () => {
    expect(() => parsePackageLock('{', 'a/package-lock.json', 'x')).toThrow(
      /a\/package-lock.json: invalid JSON/,
    );
  });

  it('returns an empty graph for an empty lock', () => {
    const { graph } = parsePackageLock('{"lockfileVersion": 3}', 'package-lock.json', 'fallback');
    expect(graph.root).toBe('fallback');
    expect(graph.nodes.size).toBe(0);
  });

  it('skips git / file dependencies and uses aliased names', () => {
    const lock = {
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { fork: 'github:a/b', alias: 'npm:lodash@4.17.20' } },
        'node_modules/fork': { version: '1.0.0', resolved: 'git+ssh://git@github.com/a/b.git#abc' },
        'node_modules/alias': {
          name: 'lodash',
          version: '4.17.20',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz',
        },
      },
    };
    const { graph, warnings } = parsePackageLock(JSON.stringify(lock), 'package-lock.json', 'x');
    expect([...graph.nodes.keys()]).toEqual(['lodash@4.17.20']);
    expect(graph.nodes.get('lodash@4.17.20')!.isDirect).toBe(true);
    expect(warnings[0]!.code).toBe('non-registry-version');
  });
});
