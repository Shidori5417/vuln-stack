import { describe, expect, it } from 'vitest';
import {
  directDependencyNames,
  parsePackageJsonManifest,
  readPackageJson,
} from '../src/ecosystems/npm/package-json.js';

describe('package.json manifest', () => {
  const pkg = readPackageJson(
    JSON.stringify({
      dependencies: {
        lodash: '~4.17.10',
        local: 'file:../x',
        ws: 'workspace:*',
        gh: 'user/repo',
        aliased: 'npm:minimist@1.2.0',
        bare: '',
      },
      devDependencies: { 'left-pad': '^1.3.0' },
      peerDependencies: { react: '>=17' },
      optionalDependencies: { fsevents: '^2' },
    }),
    'package.json',
  );
  const { graph, warnings } = parsePackageJsonManifest(pkg, 'package.json', 'fallback');

  it('keeps ranges unresolved and marks medium confidence', () => {
    expect(graph.root).toBe('fallback');
    const lodash = [...graph.nodes.values()].find((d) => d.name === 'lodash')!;
    expect(lodash).toMatchObject({
      version: '',
      declaredRange: '~4.17.10',
      confidence: 'medium',
      isDirect: true,
      scope: 'prod',
    });
  });

  it('follows npm: aliases and skips non-registry specs', () => {
    const names = [...graph.nodes.values()]
      .map((d) => `${d.name}:${d.declaredRange}:${d.scope}`)
      .sort();
    expect(names).toEqual([
      'bare:*:prod',
      'fsevents:^2:optional',
      'left-pad:^1.3.0:dev',
      'lodash:~4.17.10:prod',
      'minimist:1.2.0:prod',
      'react:>=17:peer',
    ]);
    expect(warnings.filter((w) => w.code === 'non-registry-version')).toHaveLength(3);
    expect(warnings.at(-1)!.code).toBe('no-lockfile');
  });

  it('lists direct names and rejects invalid JSON', () => {
    expect(directDependencyNames(pkg).size).toBe(9);
    expect(() => readPackageJson('nope', 'x/package.json')).toThrow(/x\/package.json/);
  });
});
