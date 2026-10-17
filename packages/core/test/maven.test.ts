import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { interpolate, loadPomChain, pomGraph, readPom } from '../src/ecosystems/maven/pom.js';
import {
  parseGradleBuild,
  parseGradleLockfile,
  parseVersionCatalog,
} from '../src/ecosystems/maven/gradle.js';
import { isPrerelease, parseMavenRange } from '../src/ecosystems/maven/ranges.js';
import { mavenPlugin } from '../src/ecosystems/maven/index.js';
import { collectSubprojects } from '../src/sources/discover.js';
import { MemoryFileProvider } from '../src/sources/file-provider.js';
import { FsFileProvider } from '../src/node/fs-provider.js';
import { MemoryCache } from '../src/cache/memory.js';
import { FIXTURES } from './helpers.js';

const deps = (g: {
  nodes: Map<
    string,
    { name: string; version: string; declaredRange?: string; scope?: string; isDirect: boolean }
  >;
}) =>
  [...g.nodes.values()]
    .map(
      (d) =>
        `${d.name}@${d.version || d.declaredRange}:${d.scope}:${d.isDirect ? 'direct' : 'trans'}`,
    )
    .sort();

describe('pom.xml', () => {
  it('resolves properties, managed versions and parent POMs in a multi-module build', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'maven/multi-module')),
    );
    expect(subprojects.map((s) => s.path)).toEqual(['app']); // aggregator root is skipped
    const { graph, warnings } = subprojects[0]!;
    expect(graph.root).toBe('acme-app');
    expect(deps(graph)).toEqual([
      'com.acme:acme-common@1.0.0:prod:direct',
      'com.fasterxml.jackson.core:jackson-databind@2.9.8:prod:direct',
      'com.google.guava:guava@[29.0-jre,30.0-jre):prod:direct',
      'junit:junit@4.12:dev:direct',
      'org.apache.logging.log4j:log4j-core@2.14.1:prod:direct',
    ]);
    expect(warnings.map((w) => w.code)).toEqual(['unresolved-version', 'direct-only']);
    expect(warnings[0]!.message).toContain('spring-boot-starter-web');
  });

  it('interpolates nested properties and stops on cycles', () => {
    const props = new Map([
      ['a', '${b}'],
      ['b', '1.0'],
      ['loop', '${loop}'],
    ]);
    expect(interpolate('${a}', props)).toBe('1.0');
    expect(interpolate('${missing}', props)).toBe('${missing}');
    expect(interpolate('${loop}', props)).toBe('${loop}');
  });

  it('reports invalid POMs and unresolvable versions', async () => {
    expect(() => readPom('<project><broken></project>', 'pom.xml')).toThrow(/pom.xml/);
    expect(() => readPom('<foo/>', 'pom.xml')).toThrow(/no <project>/);
    const provider = new MemoryFileProvider({
      'pom.xml': `<project><parent><relativePath>../../outside/pom.xml</relativePath></parent><artifactId>x</artifactId>
        <dependencies>
          <dependency><groupId>a</groupId><artifactId>b</artifactId><version>\${nope}</version></dependency>
          <dependency><groupId>c</groupId><artifactId>d</artifactId><version>LATEST-SNAPSHOT</version></dependency>
          <dependency><artifactId>no-group</artifactId></dependency>
        </dependencies></project>`,
    });
    const chain = await loadPomChain('pom.xml', provider);
    expect(chain).toHaveLength(1);
    const { graph, warnings } = pomGraph(chain, 'pom.xml', 'fallback');
    expect(graph.nodes.size).toBe(0);
    expect(warnings.map((w) => w.code)).toEqual([
      'unresolved-version',
      'non-registry-version',
      'direct-only',
    ]);
    await expect(loadPomChain('missing.xml', provider)).rejects.toThrow();
  });

  it('follows a parent directory relativePath', async () => {
    const provider = new MemoryFileProvider({
      'parent/pom.xml': '<project><properties><v>3.0</v></properties></project>',
      'child/pom.xml':
        '<project><parent><relativePath>../parent</relativePath></parent><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>${v}</version></dependency></dependencies></project>',
    });
    const { graph } = pomGraph(
      await loadPomChain('child/pom.xml', provider),
      'child/pom.xml',
      'child',
    );
    expect(graph.nodes.has('g:a@3.0')).toBe(true);
  });
});

describe('Gradle', () => {
  it('combines gradle.lockfile with declared deps and the version catalog', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'gradle/kotlin-dsl')),
    );
    const { graph, warnings } = subprojects[0]!;
    expect(graph.nodes.get('org.apache.logging.log4j:log4j-core@2.14.1')).toMatchObject({
      isDirect: true,
      scope: 'prod',
    });
    expect(graph.nodes.get('org.apache.logging.log4j:log4j-api@2.14.1')).toMatchObject({
      isDirect: false,
    });
    expect(graph.nodes.get('org.apache.commons:commons-text@1.9')!.isDirect).toBe(true); // from the catalog
    expect(graph.nodes.get('junit:junit@4.12')).toMatchObject({ isDirect: true, scope: 'dev' });
    expect(graph.nodes.get('org.hamcrest:hamcrest-core@1.3')!.scope).toBe('dev');
    expect(graph.nodes.size).toBe(9);
    expect(warnings).toEqual([]);
  });

  it('parses Groovy build scripts with variables and map notation', async () => {
    const { subprojects } = await collectSubprojects(
      new FsFileProvider(join(FIXTURES, 'gradle/groovy')),
    );
    const { graph, warnings } = subprojects[0]!;
    expect(deps(graph)).toEqual([
      'com.h2database:h2@1.4.+:prod:direct',
      'junit:junit@4.12:dev:direct',
      'org.springframework:spring-core@5.2.0.RELEASE:prod:direct',
      'org.springframework:spring-web@5.3.0:prod:direct',
      'org.yaml:snakeyaml@1.26:prod:direct',
    ]);
    expect(warnings.map((w) => w.code)).toEqual([
      'unresolved-version',
      'unresolved-version',
      'direct-only',
    ]);
  });

  it('handles lockfiles without a build file', () => {
    const { graph, warnings } = parseGradleLockfile(
      'a:b:1.0=runtimeClasspath\nbad line\nc:d:[1,2)=x\n',
      'gradle.lockfile',
      'x',
      undefined,
    );
    expect([...graph.nodes.keys()]).toEqual(['a:b@1.0']);
    expect(graph.nodes.get('a:b@1.0')!.isDirect).toBe(true);
    expect(warnings[0]!.code).toBe('direct-unknown');
  });

  it('reads catalog entries in all notations', () => {
    const { deps: d } = parseVersionCatalog(
      `[versions]
x = { strictly = "1.0" }
[libraries]
a = { group = "g", name = "a", version.ref = "x" }
b = { module = "g:b", version = { require = "2.0" } }
c = "g:c:3.0"
d = { module = "g:d" }
e = "bad"
`,
      'libs.versions.toml',
    );
    expect(d.map((x) => `${x.name}@${x.version}`)).toEqual([
      'g:a@1.0',
      'g:b@2.0',
      'g:c@3.0',
      'g:d@',
    ]);
    expect(() => parseVersionCatalog('[', 'libs.versions.toml')).toThrow(/invalid TOML/);
  });

  it('extracts classifiers and platform() declarations', () => {
    const { deps: d } = parseGradleBuild(
      `dependencies {\n  implementation 'g:a:1.0:sources@jar'\n  api(enforcedPlatform("g:bom:2.0"))\n}`,
      'build.gradle',
    );
    expect(d.map((x) => `${x.name}@${x.version}`)).toEqual(['g:a@1.0', 'g:bom@2.0']);
  });
});

describe('Maven ranges and resolution', () => {
  it('matches Maven and Gradle range syntax', () => {
    const r = parseMavenRange('[1.0,2.0)')!;
    expect([r('1.0'), r('1.5'), r('2.0')]).toEqual([true, true, false]);
    const open = parseMavenRange('(,1.0]')!;
    expect([open('0.9'), open('1.0'), open('1.1')]).toEqual([true, true, false]);
    const exact = parseMavenRange('[1.5]')!;
    expect([exact('1.5'), exact('1.6')]).toEqual([true, false]);
    const union = parseMavenRange('[1,2),[3,)')!;
    expect([union('1.5'), union('2.5'), union('4')]).toEqual([true, false, true]);
    expect(parseMavenRange('1.4.+')!('1.4.200')).toBe(true);
    expect(parseMavenRange('1.4.+')!('1.5.0')).toBe(false);
    expect(parseMavenRange('latest.release')!('9')).toBe(true);
    expect(parseMavenRange('+')!('1')).toBe(true);
    expect(parseMavenRange('1.0')).toBeUndefined();
    expect(parseMavenRange('(1.0,2.0]!!')!('2.0')).toBe(true);
    expect(isPrerelease('2.0-RC1')).toBe(true);
    expect(isPrerelease('2.0.1')).toBe(false);
  });

  it('resolves against maven-metadata.xml', async () => {
    const calls: string[] = [];
    const net = {
      cache: new MemoryCache(),
      userAgent: 't',
      fetch: async (url: string) => {
        calls.push(url);
        if (url.includes('missing')) return new Response('', { status: 404 });
        return new Response(
          '<metadata><versioning><versions><version>1.4.199</version><version>1.4.200</version><version>2.0.202</version><version>2.1.0-RC1</version></versions></versioning></metadata>',
        );
      },
    };
    expect(await mavenPlugin.resolveRange!('com.h2database:h2', '1.4.+', net)).toBe('1.4.200');
    expect(await mavenPlugin.resolveRange!('com.h2database:h2', 'latest.release', net)).toBe(
      '2.0.202',
    );
    expect(await mavenPlugin.resolveRange!('com.h2database:h2', 'latest.integration', net)).toBe(
      '2.1.0-RC1',
    );
    expect(await mavenPlugin.resolveRange!('com.h2database:h2', '1.0', net)).toBeNull();
    expect(await mavenPlugin.resolveRange!('nogroup', '+', net)).toBeNull();
    expect(await mavenPlugin.resolveRange!('x:missing', '+', net)).toBeNull();
    expect(calls[0]).toBe('https://repo1.maven.org/maven2/com/h2database/h2/maven-metadata.xml');
    expect(calls).toHaveLength(2);
  });
});
