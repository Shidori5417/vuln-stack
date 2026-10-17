import { describe, expect, it } from 'vitest';
import { npmVersioning as v } from '../src/ecosystems/npm/versioning.js';

describe('npmVersioning', () => {
  it('compares semver including prereleases', () => {
    expect(v.compare('4.17.1', '4.20.0')).toBeLessThan(0);
    expect(v.compare('5.0.0-alpha.1', '5.0.0')).toBeLessThan(0);
    expect(v.compare('1.0.0', '1.0.0')).toBe(0);
  });

  it('sorts invalid versions before valid ones without throwing', () => {
    expect(v.compare('garbage', '1.0.0')).toBeLessThan(0);
    expect(v.compare('1.0.0', 'garbage')).toBeGreaterThan(0);
    expect(v.compare('a', 'b')).toBeLessThan(0);
    expect(v.isValid('nope')).toBe(false);
    expect(v.isValid('v1.2.3')).toBe(true);
  });

  it('applies caret semantics for major bumps', () => {
    expect(v.isMajorBump('4.17.1', '4.20.0')).toBe(false);
    expect(v.isMajorBump('4.17.1', '5.0.0')).toBe(true);
    expect(v.isMajorBump('0.5.1', '0.5.6')).toBe(false);
    expect(v.isMajorBump('0.5.1', '0.6.0')).toBe(true);
    expect(v.isMajorBump('0.0.8', '0.0.9')).toBe(true);
    expect(v.isMajorBump('x', '1.0.0')).toBe(true);
  });
});
