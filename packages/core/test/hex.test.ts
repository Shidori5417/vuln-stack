import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMixExs, parseMixLock } from '../src/ecosystems/hex/index.js';
import { parseTerms } from '../src/ecosystems/hex/terms.js';
import { chainNames, computePaths } from '../src/model/graph.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { collectSubprojects } from '../src/sources/discover.js';
import { FIXTURES } from './helpers.js';

describe('mix.lock', () => {
  it('reads packages, edges, direct and dev-only deps via mix.exs', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'hex/phoenix-app')),
    );
    const { graph, warnings, ecosystem } = subprojects[0]!;
    expect(ecosystem).toBe('Hex');
    expect(graph.nodes.size).toBe(13);
    const direct = [...graph.nodes.values()].filter((d) => d.isDirect).map((d) => d.name);
    expect(direct.sort()).toEqual(['ex_doc', 'jason', 'phoenix', 'plug_cowboy']);
    expect(graph.nodes.get('ex_doc@0.23.0')!.scope).toBe('dev');
    expect(graph.nodes.get('earmark_parser@1.4.12')!.scope).toBe('dev');
    expect(graph.nodes.get('jason@1.2.2')!.scope).toBe('prod');
    expect(graph.nodes.get('cowboy@2.8.0')).toMatchObject({ confidence: 'high', isDirect: false });
    const paths = computePaths(graph);
    expect(chainNames(graph, paths.get('ranch@1.7.1')!.path)).toEqual([
      'root',
      'plug_cowboy',
      'cowboy',
      'ranch',
    ]);
    expect(warnings.map((w) => w.code)).toEqual(['non-registry-version']);
  });

  it('falls back to packages nobody depends on without mix.exs', () => {
    const lock = `%{
  "a": {:hex, :a, "1.0.0", "x", [:mix], [{:b, "~> 1.0", [hex: :b, repo: "hexpm", optional: false]}], "hexpm", "y"},
  "b": {:hex, :b, "1.1.0", "x", [:mix], [], "hexpm", "y"},
}`;
    const { graph } = parseMixLock(lock, 'mix.lock', 'x');
    expect(graph.nodes.get('a@1.0.0')!.isDirect).toBe(true);
    expect(graph.nodes.get('b@1.1.0')!.isDirect).toBe(false);
  });

  it('uses the Hex package name when it differs from the app name', () => {
    const lock = `%{"app_name": {:hex, :real_pkg, "1.0.0", "x", [:mix], [], "hexpm", "y"}}`;
    expect([...parseMixLock(lock, 'mix.lock', 'x').graph.nodes.keys()]).toEqual(['real_pkg@1.0.0']);
  });

  it('skips private repositories and never throws on malformed input', () => {
    const priv = `%{"p": {:hex, :p, "1.0.0", "x", [:mix], [], "hexpm:acme", "y"}}`;
    expect(parseMixLock(priv, 'mix.lock', 'x').warnings[0]!.code).toBe('non-registry-version');
    for (const junk of [
      '',
      '%{',
      '%{"a": {:hex, :a',
      'not elixir',
      '[[[[',
      '%{"a": "unterminated}',
    ]) {
      expect(() => parseMixLock(junk, 'mix.lock', 'x')).not.toThrow();
    }
    expect(parseMixLock('%{', 'mix.lock', 'x').warnings[0]!.code).toBe('malformed-lockfile');
    expect(parseMixLock('[1]', 'mix.lock', 'x').warnings[0]!.code).toBe('malformed-lockfile');
  });
});

describe('Elixir term reader', () => {
  it('parses maps, tuples, keyword lists, comments and escapes', () => {
    const t = parseTerms('# c\n%{"a" => {:x, "s\\"q", [k: :v, "q": 1]}}');
    expect(t).toEqual({
      map: [
        [
          'a',
          {
            tuple: [
              { atom: 'x' },
              's"q',
              [
                { key: 'k', value: { atom: 'v' } },
                { key: 'q', value: 1 },
              ],
            ],
          },
        ],
      ],
    });
  });

  it('rejects absurd nesting instead of overflowing the stack', () => {
    expect(() => parseTerms('['.repeat(5000))).toThrow();
  });
});

describe('mix.exs', () => {
  it('finds dependency tuples and only: scopes', () => {
    const deps = parseMixExs(
      '{:a, "~> 1.0"}, {:b, "~> 1", only: [:dev, :test]}, {:c, git: "x"}, {:d, "1", only: [:dev, :prod]}',
    );
    expect([...deps]).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
      ['d', false],
    ]);
  });
});
