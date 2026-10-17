import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGemfileLock, stripPlatform } from '../src/ecosystems/rubygems/index.js';
import { rubygemsVersioning as v } from '../src/ecosystems/rubygems/versioning.js';
import { chainNames, computePaths } from '../src/model/graph.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { collectSubprojects } from '../src/sources/discover.js';
import { FIXTURES } from './helpers.js';

describe('Gemfile.lock', () => {
  it('reads GEM/GIT/PATH specs, edges and direct dependencies', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'rubygems/rails-app')),
    );
    expect(subprojects).toHaveLength(1);
    const { graph, warnings, ecosystem } = subprojects[0]!;
    expect(ecosystem).toBe('RubyGems');
    // Platform variant of nokogiri collapses into one node.
    expect([...graph.nodes.keys()].sort()).toEqual([
      'actionpack@5.2.2',
      'forked-gem@0.3.0',
      'internal_lib@1.0.0',
      'mini_portile2@2.4.0',
      'nokogiri@1.10.3',
      'rack-test@1.1.0',
      'rack@2.0.1',
      'rails@5.2.2',
    ]);
    const direct = [...graph.nodes.values()].filter((d) => d.isDirect).map((d) => d.name);
    expect(direct.sort()).toEqual(['forked-gem', 'internal_lib', 'nokogiri', 'rails']);
    expect(graph.nodes.get('rails@5.2.2')).toMatchObject({ confidence: 'high', scope: 'prod' });
    expect(graph.nodes.get('forked-gem@0.3.0')!.internal).toBe(true);
    expect(graph.nodes.get('internal_lib@1.0.0')!.internal).toBe(true);
    expect(graph.nodes.get('rack@2.0.1')!.internal).toBeUndefined();
    expect(warnings.map((w) => w.code)).toEqual(['non-registry-version', 'non-registry-version']);
    const paths = computePaths(graph);
    expect(chainNames(graph, paths.get('rack@2.0.1')!.path)).toEqual([
      'root',
      'forked-gem',
      'rack',
    ]);
    expect(graph.nodes.get('rails@5.2.2')!.sourceFile).toBe('Gemfile.lock');
  });

  it('strips platform suffixes and tolerates garbage', () => {
    expect(stripPlatform('1.13.3-x86_64-linux')).toBe('1.13.3');
    expect(stripPlatform('1.0.0.pre1-java')).toBe('1.0.0.pre1');
    for (const junk of ['', '\0\0', 'GEM\n  specs:\n    broken', 'DEPENDENCIES\n  ???\n']) {
      expect(() => parseGemfileLock(junk, 'Gemfile.lock', 'x')).not.toThrow();
    }
  });

  it('treats gems nobody depends on as direct when DEPENDENCIES is missing', () => {
    const { graph } = parseGemfileLock(
      'GEM\n  remote: https://rubygems.org/\n  specs:\n    a (1.0)\n      b (>= 1)\n    b (2.0)\n',
      'Gemfile.lock',
      'x',
    );
    expect(graph.nodes.get('a@1.0')!.isDirect).toBe(true);
    expect(graph.nodes.get('b@2.0')!.isDirect).toBe(false);
  });
});

describe('RubyGems versioning', () => {
  it('orders like Gem::Version', () => {
    const sorted = ['1.10', '1.2', '1.0.a', '1.0', '1.0.0.pre1', '1.0.1', '0.9'].sort(v.compare);
    expect(sorted).toEqual(['0.9', '1.0.a', '1.0.0.pre1', '1.0', '1.0.1', '1.2', '1.10']);
    expect(v.compare('1.0', '1.0.0')).toBe(0);
    expect(v.compare('2.0.0-rc1', '2.0.0')).toBeLessThan(0);
  });

  it('never throws and detects major bumps', () => {
    expect(() => v.compare('???', '1.0')).not.toThrow();
    expect(v.compare('???', '1.0')).toBeLessThan(0);
    expect(v.isValid('1.2.3')).toBe(true);
    expect(v.isValid('abc')).toBe(false);
    expect(v.isMajorBump('5.2.2', '6.0.0')).toBe(true);
    expect(v.isMajorBump('5.2.2', '5.2.8')).toBe(false);
  });
});
