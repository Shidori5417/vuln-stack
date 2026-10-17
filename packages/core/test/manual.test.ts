import { describe, expect, it } from 'vitest';
import { guessEcosystem, manualSubprojects, parseManualInput } from '../src/sources/manual.js';

describe('parseManualInput', () => {
  it('parses the common notations', () => {
    const { entries, errors } = parseManualInput(
      'react@18.2.0, express 4.17.1\ndjango 4.1; pypi:requests==2.19.0\n@types/node@20.1.0\n# comment\nnpm:lodash',
    );
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.ecosystem, e.name, e.version, e.ecosystemExplicit])).toEqual([
      ['npm', 'react', '18.2.0', false],
      ['npm', 'express', '4.17.1', false],
      ['PyPI', 'django', '4.1', false],
      ['PyPI', 'requests', '2.19.0', true],
      ['npm', '@types/node', '20.1.0', false],
      ['npm', 'lodash', '', true],
    ]);
  });

  it('understands Maven, Go, Packagist and NuGet shapes', () => {
    const { entries } = parseManualInput(
      'org.apache.logging.log4j:log4j-core:2.14.1, go:github.com/gin-gonic/gin@v1.6.0, laravel/framework 8.0.0, Newtonsoft.Json 12.0.1, flask==1.0, x@latest',
    );
    expect(entries.map((e) => [e.ecosystem, e.name, e.version])).toEqual([
      ['Maven', 'org.apache.logging.log4j:log4j-core', '2.14.1'],
      ['Go', 'github.com/gin-gonic/gin', '1.6.0'],
      ['Packagist', 'laravel/framework', '8.0.0'],
      ['NuGet', 'Newtonsoft.Json', '12.0.1'],
      ['PyPI', 'flask', '1.0'],
      ['npm', 'x', ''],
    ]);
  });

  it('reports what it cannot parse', () => {
    const { errors, entries } = parseManualInput(
      'a b c, ???bad stuff, react nightly, x@*, go:github.com/a/b@v0.0.0-2020-abc',
    );
    expect(errors).toEqual([
      { raw: 'a b c', message: 'Could not understand "a b c"' },
      { raw: '???bad stuff', message: '"???bad" is not a valid package name' },
      { raw: 'react nightly', message: '"nightly" is not a valid version' },
    ]);
    expect(entries.map((e) => `${e.name}@${e.version}`)).toEqual([
      'x@',
      'github.com/a/b@0.0.0-2020-abc',
    ]);
  });
});

describe('guessEcosystem', () => {
  it('defaults to npm', () => {
    expect(guessEcosystem('left-pad')).toBe('npm');
    expect(guessEcosystem('golang.org/x/net')).toBe('Go');
    expect(guessEcosystem('com.google.guava:guava')).toBe('Maven');
  });
});

describe('manualSubprojects', () => {
  it('creates one subproject per ecosystem with direct deps', () => {
    const subs = manualSubprojects(parseManualInput('react@18.2.0, django 4.1, lodash').entries);
    expect(subs.map((s) => [s.ecosystem, s.graph.nodes.size])).toEqual([
      ['npm', 2],
      ['PyPI', 1],
    ]);
    const lodash = [...subs[0]!.graph.nodes.values()].find((d) => d.name === 'lodash')!;
    expect(lodash).toMatchObject({
      version: '',
      declaredRange: '*',
      confidence: 'medium',
      isDirect: true,
    });
  });
});
