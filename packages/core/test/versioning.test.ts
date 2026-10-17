import { describe, expect, it } from 'vitest';
import { goVersioning } from '../src/ecosystems/go/versioning.js';
import {
  compareMaven,
  mavenVersioning,
  tokenizeMaven,
} from '../src/ecosystems/maven/versioning.js';
import { nugetVersioning } from '../src/ecosystems/nuget/versioning.js';
import {
  packagistVersioning,
  parseComposerVersion,
} from '../src/ecosystems/packagist/versioning.js';
import { normalizePypiName, pypiVersioning } from '../src/ecosystems/pypi/versioning.js';
import { caretBreaking, compareNumeric } from '../src/ecosystems/shared.js';
import type { Versioning } from '../src/ecosystems/types.js';

/** Asserts that `versions` is strictly ascending under `v`. */
function expectAscending(v: Versioning, versions: string[]) {
  for (let i = 0; i < versions.length - 1; i++) {
    const [a, b] = [versions[i]!, versions[i + 1]!];
    expect(v.compare(a, b), `${a} < ${b}`).toBeLessThan(0);
    expect(v.compare(b, a), `${b} > ${a}`).toBeGreaterThan(0);
  }
}

describe('shared helpers', () => {
  it('treats missing parts as zero and applies caret rules', () => {
    expect(compareNumeric([1, 2], [1, 2, 0])).toBe(0);
    expect(compareNumeric([1, 2], [1, 3])).toBeLessThan(0);
    expect(caretBreaking([1, 2], [1, 9])).toBe(false);
    expect(caretBreaking([1], [2])).toBe(true);
    expect(caretBreaking([0, 3], [0, 4])).toBe(true);
    expect(caretBreaking([0, 3, 1], [0, 3, 9])).toBe(false);
  });
});

describe('PyPI (PEP 440)', () => {
  it('orders pre/post/dev releases and epochs', () => {
    expectAscending(pypiVersioning, [
      '1.0.dev1',
      '1.0a1',
      '1.0b2',
      '1.0rc1',
      '1.0',
      '1.0.post1',
      '1.1',
      '1!0.1',
    ]);
    expect(pypiVersioning.compare('2.0', '2.0.0')).toBe(0);
  });

  it('validates and detects breaking upgrades', () => {
    expect(pypiVersioning.isValid('4.1')).toBe(true);
    expect(pypiVersioning.isValid('not a version')).toBe(false);
    expect(pypiVersioning.compare('junk', '1.0')).toBeLessThan(0);
    expect(pypiVersioning.isMajorBump('4.1', '4.2.7')).toBe(false);
    expect(pypiVersioning.isMajorBump('3.2', '4.0')).toBe(true);
    expect(pypiVersioning.isMajorBump('0.9', '0.10')).toBe(true);
    expect(pypiVersioning.isMajorBump('1.0', '1!1.0')).toBe(true);
    expect(pypiVersioning.isMajorBump('x', '1.0')).toBe(true);
  });

  it('normalises names (PEP 503)', () => {
    expect(normalizePypiName('Django')).toBe('django');
    expect(normalizePypiName('zope.interface')).toBe('zope-interface');
    expect(normalizePypiName('typing__Extensions')).toBe('typing-extensions');
  });
});

describe('Go', () => {
  it('handles the v prefix, pseudo-versions and +incompatible', () => {
    expectAscending(goVersioning, [
      'v0.0.0-20200101000000-abcdef123456',
      'v0.1.0',
      'v1.6.0',
      '1.6.1',
      'v2.0.0+incompatible',
    ]);
    expect(goVersioning.isValid('v1.2.3')).toBe(true);
    expect(goVersioning.isValid('master')).toBe(false);
    expect(goVersioning.compare('master', 'v1.0.0')).toBeLessThan(0);
    expect(goVersioning.isMajorBump('v1.6.0', 'v1.9.1')).toBe(false);
    expect(goVersioning.isMajorBump('v0.3.0', 'v0.4.0')).toBe(true);
    expect(goVersioning.isMajorBump('bad', 'v1.0.0')).toBe(true);
    expect(goVersioning.displayVersion!('1.7.7', 'v1.6.0')).toBe('v1.7.7');
    expect(goVersioning.displayVersion!('v1.7.7', 'v1.6.0')).toBe('v1.7.7');
    expect(goVersioning.displayVersion!('1.20.2', '1.20.1')).toBe('1.20.2');
  });
});

describe('Packagist (Composer)', () => {
  it('orders stabilities and handles v prefixes', () => {
    expectAscending(packagistVersioning, [
      '1.0.0-dev',
      '1.0.0-alpha1',
      '1.0.0-beta2',
      '1.0.0-RC1',
      '1.0.0',
      'v1.0.0-p1',
      '1.0.1',
      '1.0.1.1',
      'v2.0',
    ]);
    expect(packagistVersioning.compare('v5.4.3', '5.4.3')).toBe(0);
  });

  it('rejects branches and detects breaking upgrades', () => {
    expect(parseComposerVersion('dev-master')).toBeNull();
    expect(packagistVersioning.isValid('dev-main')).toBe(false);
    expect(packagistVersioning.isMajorBump('v4.4.0', 'v4.4.50')).toBe(false);
    expect(packagistVersioning.isMajorBump('4.4.0', '5.0.0')).toBe(true);
    expect(packagistVersioning.isMajorBump('dev-master', '1.0')).toBe(true);
  });
});

describe('NuGet', () => {
  it('orders four-part versions and prereleases', () => {
    expectAscending(nugetVersioning, [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.0.1',
      '12.0.1',
      '13.0.1',
    ]);
    expect(nugetVersioning.compare('1.0', '1.0.0.0')).toBe(0);
    expect(nugetVersioning.compare('1.0.0-RC', '1.0.0-rc')).toBe(0);
    expect(nugetVersioning.compare('1.0.0+build', '1.0.0')).toBe(0);
  });

  it('validates and detects breaking upgrades', () => {
    expect(nugetVersioning.isValid('[1.0,2.0)')).toBe(false);
    expect(nugetVersioning.isMajorBump('12.0.1', '13.0.1')).toBe(true);
    expect(nugetVersioning.isMajorBump('6.0.0', '6.0.25')).toBe(false);
    expect(nugetVersioning.isMajorBump('x', '1.0')).toBe(true);
  });
});

describe('Maven', () => {
  it('follows ComparableVersion ordering', () => {
    expectAscending(mavenVersioning, [
      '1.0-alpha-1',
      '1.0-alpha2',
      '1.0-beta',
      '1.0-milestone-1',
      '1.0-rc1',
      '1.0-SNAPSHOT',
      '1.0',
      '1.0-sp1',
      '1.0-jre',
      '1.0.1',
      '1.1',
      '2.12.7',
      '2.12.7.1',
      '2.14.1',
      '2.15.0',
    ]);
    expect(compareMaven('1.0.0.Final', '1')).toBe(0);
    expect(compareMaven('1.0-GA', '1.0')).toBe(0);
    expect(compareMaven('1.0-CR1', '1.0-rc1')).toBe(0);
    expect(compareMaven('31.1-jre', '32.0.0-jre')).toBeLessThan(0);
    expect(compareMaven('1.0-a1', '1.0-alpha1')).toBe(0);
  });

  it('tokenizes and strips trailing nulls', () => {
    expect(tokenizeMaven('1.0.0.Final')).toEqual([{ kind: 'int', value: 1 }]);
    expect(tokenizeMaven('2.0b')).toEqual([
      { kind: 'int', value: 2 },
      { kind: 'int', value: 0 },
      { kind: 'str', value: 'b' },
    ]);
  });

  it('validates and detects breaking upgrades', () => {
    expect(mavenVersioning.isValid('2.14.1')).toBe(true);
    expect(mavenVersioning.isValid('[1.0,2.0)')).toBe(false);
    expect(mavenVersioning.isValid('${log4j.version}')).toBe(false);
    expect(mavenVersioning.isMajorBump('2.14.1', '2.17.1')).toBe(false);
    expect(mavenVersioning.isMajorBump('5.3.0', '6.0.0')).toBe(true);
    expect(mavenVersioning.isMajorBump('RELEASE', '1.0')).toBe(true);
  });
});
