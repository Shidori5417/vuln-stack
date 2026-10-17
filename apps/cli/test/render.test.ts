import { describe, expect, it } from 'vitest';
import pc from 'picocolors';
import type { Warning } from '@vulnstack/core';
import { colorsFor } from '../src/render/colors.js';
import { formatChain, formatCounts, plural } from '../src/render/table.js';
import { renderWarnings } from '../src/render/warnings.js';
import { createFetch } from '../src/net.js';

const plain = pc.createColors(false);

describe('render helpers', () => {
  it('shortens long chains in the middle', () => {
    expect(formatChain(['a', 'b', 'c'])).toBe('a > b > c');
    expect(formatChain(['app', 'a', 'b', 'c', 'd', 'e'])).toBe('app > a > … > d > e');
  });

  it('formats counts and plurals', () => {
    expect(formatCounts({ critical: 1, high: 0, medium: 2, low: 0, unknown: 3 }, plain)).toBe(
      '1 critical, 2 medium, 3 unknown',
    );
    expect(plural(1, 'dependency', 'dependencies')).toBe('1 dependency');
    expect(plural(2, 'project')).toBe('2 projects');
  });

  it('dedupes and caps warnings', () => {
    const w: Warning[] = Array.from({ length: 12 }, (_, i) => ({ code: 'x', message: `m${i}` }));
    const out = renderWarnings([...w, w[0]!], plain);
    expect(out.split('\n').filter(Boolean)).toHaveLength(9);
    expect(out).toContain('…and 4 more warnings');
    expect(renderWarnings([], plain)).toBe('');
  });

  it('decides on colors from the stream and env', () => {
    expect(colorsFor({ isTTY: true }, {}).isColorSupported).toBe(true);
    expect(colorsFor({ isTTY: true }, { NO_COLOR: '' }).isColorSupported).toBe(false);
    expect(colorsFor({ isTTY: true }, { TERM: 'dumb' }).isColorSupported).toBe(false);
    expect(colorsFor({}, { FORCE_COLOR: '1' }).isColorSupported).toBe(true);
    expect(colorsFor({}, { FORCE_COLOR: '0' }).isColorSupported).toBe(false);
  });

  it('only builds a proxy fetch when a proxy is configured', () => {
    expect(createFetch({})).toBeUndefined();
    expect(typeof createFetch({ HTTPS_PROXY: 'http://proxy.local:3128' })).toBe('function');
  });
});
