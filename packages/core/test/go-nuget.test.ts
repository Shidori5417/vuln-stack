import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { goModGraph, parseGoMod } from '../src/ecosystems/go/index.js';
import {
  nugetPlugin,
  parseNuGetLock,
  parseNuGetRange,
  parseProjectFile,
} from '../src/ecosystems/nuget/index.js';
import { chainNames, computePaths } from '../src/model/graph.js';
import { collectSubprojects } from '../src/sources/discover.js';
import { MemoryFileProvider } from '../src/sources/file-provider.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { MemoryCache } from '../src/cache/memory.js';
import { FIXTURES, json } from './helpers.js';

describe('go.mod', () => {
  it('reads requires, replaces, indirect markers and the toolchain', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'go/gin-app')),
    );
    const { graph, warnings } = subprojects[0]!;
    expect(graph.root).toBe('github.com/acme/gin-app');
    const nodes = [...graph.nodes.values()]
      .map((d) => `${d.name}@${d.version}:${d.isDirect ? 'direct' : 'indirect'}`)
      .sort();
    expect(nodes).toEqual([
      'github.com/dgrijalva/jwt-go@v3.2.0+incompatible:direct',
      'github.com/gin-gonic/gin@v1.6.0:direct',
      'golang.org/x/text@v0.3.7:indirect',
      'gopkg.in/yaml.v2@v2.4.0:indirect',
      'stdlib@1.20.1:direct',
    ]);
    expect(graph.nodes.get('stdlib@1.20.1')!.confidence).toBe('medium');
    expect(warnings.map((w) => w.code)).toEqual(['non-registry-version']);
  });

  it('parses single-line directives, quoted paths and comments', () => {
    const mod = parseGoMod(
      '// header\nmodule "example.com/m" // c\ngo 1.16\nrequire `a.b/c` v1.0.0\nreplace a.b/c v1.0.0 => a.b/d v1.1.0\nexclude x v1\n',
    );
    expect(mod).toMatchObject({
      module: 'example.com/m',
      go: '1.16',
      requires: [{ path: 'a.b/c', version: 'v1.0.0', indirect: false }],
    });
    const { graph, warnings } = goModGraph(mod, 'go.mod', 'x');
    expect([...graph.nodes.keys()]).toEqual(['a.b/d@v1.1.0']);
    expect(warnings.map((w) => w.code)).toEqual(['incomplete-go-mod']);
  });

  it('uses a three-part go directive as a low-confidence stdlib version and skips bad versions', () => {
    const { graph, warnings } = goModGraph(
      parseGoMod('module m\ngo 1.22.3\nrequire a.b/c latest\n'),
      'go.mod',
      'x',
    );
    expect(graph.nodes.get('stdlib@1.22.3')!.confidence).toBe('low');
    expect(warnings.map((w) => w.code)).toEqual(['non-registry-version']);
    expect(goModGraph(parseGoMod('go 1.21\n'), 'go.mod', 'fallback').graph.root).toBe('fallback');
  });
});

describe('NuGet', () => {
  it('merges target frameworks in packages.lock.json', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'nuget/locked')),
    );
    expect(subprojects).toHaveLength(1);
    const { graph, path } = subprojects[0]!;
    expect(path).toBe('src/Api');
    expect(graph.root).toBe('Api');
    expect(graph.nodes.size).toBe(3);
    expect(graph.nodes.get('System.Text.Encodings.Web@5.0.0')!.isDirect).toBe(false);
    const paths = computePaths(graph);
    expect(chainNames(graph, paths.get('System.Text.Encodings.Web@5.0.0')!.path)).toEqual([
      'Api',
      'System.Text.Json',
      'System.Text.Encodings.Web',
    ]);
  });

  it('reads central package versions, overrides and private assets', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'nuget/central')),
    );
    const { graph, warnings } = subprojects[0]!;
    const nodes = [...graph.nodes.values()].map(
      (d) => `${d.name}@${d.version || d.declaredRange}:${d.scope}`,
    );
    expect(nodes).toEqual([
      'Newtonsoft.Json@12.0.1:prod',
      'Serilog@[2.10.0,3.0.0):prod',
      'StyleCop.Analyzers@1.1.118:dev',
      'Dapper@2.0.4:prod',
    ]);
    expect(warnings.map((w) => w.code)).toEqual(['unresolved-version', 'direct-only']);
  });

  it('reads packages.config', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'nuget/legacy')),
    );
    expect(
      [...subprojects[0]!.graph.nodes.values()].map((d) => `${d.name}@${d.version}:${d.scope}`),
    ).toEqual(['Newtonsoft.Json@12.0.1:prod', 'NUnit@3.12.0:dev']);
  });

  it('rejects malformed files', async () => {
    expect(() => parseNuGetLock('{', 'packages.lock.json', 'x')).toThrow(/invalid JSON/);
    await expect(
      parseProjectFile('<Project><ItemGroup></Project>', 'a.csproj', new MemoryFileProvider({})),
    ).rejects.toThrow(/invalid XML/);
    const { warnings } = parseNuGetLock(
      '{"dependencies":{"net6.0":{"X":{"type":"Direct","resolved":"not-a-version"}}}}',
      'packages.lock.json',
      'x',
    );
    expect(warnings[0]!.code).toBe('non-registry-version');
    expect(
      (
        await nugetPlugin.parse({
          dir: '',
          files: [],
          provider: new MemoryFileProvider({}),
          allFiles: [],
        })
      ).subprojects,
    ).toEqual([]);
  });

  it('parses version ranges', () => {
    const r = parseNuGetRange('[1.0,2.0)')!;
    expect([r.matches('1.0'), r.matches('1.9.9'), r.matches('2.0')]).toEqual([true, true, false]);
    expect(parseNuGetRange('(1.0,]')!.matches('1.0')).toBe(false);
    expect(parseNuGetRange('[1.5]')!.matches('1.5.0')).toBe(true);
    expect(parseNuGetRange('1.0')!.matches('1.1')).toBe(true);
    expect(parseNuGetRange('6.*')).toMatchObject({ floating: true });
    expect(parseNuGetRange('nonsense')).toBeUndefined();
  });

  it('resolves ranges to the lowest match and floats to the highest', async () => {
    const calls: string[] = [];
    const net = {
      cache: new MemoryCache(),
      userAgent: 't',
      fetch: async (url: string) => {
        calls.push(url);
        return json({ versions: ['2.9.0', '2.10.0', '2.12.0', '3.0.0-beta', '3.0.0'] });
      },
    };
    expect(await nugetPlugin.resolveRange!('Serilog', '[2.10.0,3.0.0)', net)).toBe('2.10.0');
    expect(await nugetPlugin.resolveRange!('Serilog', '2.*', net)).toBe('2.12.0');
    expect(await nugetPlugin.resolveRange!('Serilog', '[9.0]', net)).toBeNull();
    expect(await nugetPlugin.resolveRange!('Serilog', 'bad', net)).toBeNull();
    expect(calls).toEqual(['https://api.nuget.org/v3-flatcontainer/serilog/index.json']);
  });
});
